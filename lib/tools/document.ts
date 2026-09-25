import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { unzipSync } from "fflate";
import { getBinary, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";

// 공시서류원본파일(document.xml) — 접수번호로 공시 원문 ZIP을 받아 본문 텍스트로 바꾼다.
// 비상장 외감법인의 감사보고서(외부감사 공시, pblntf_ty=F)도 대상이다.

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

interface DocFile {
  name: string;
  title: string;
  text: string;
}

function decodeBytes(bytes: Uint8Array): string {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 200));
  const m = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  const enc = (m?.[1] || "utf-8").toLowerCase();
  const label = enc === "ks_c_5601-1987" || enc === "cp949" ? "euc-kr" : enc;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, "&");
}

// DART 전용 엔티티(&cr; 등)는 줄바꿈 표시다.
function crEntities(s: string, repl: string): string {
  return s.replace(/&(cr|crlf|lf);/gi, repl);
}

// 셀 안의 문단·줄바꿈은 공백으로 이어 붙인다(한 행이 한 줄에 오도록).
function cellText(inner: string): string {
  let s = inner.replace(/<(BR|PGBRK)\b[^>]*\/?>/gi, " ").replace(/<\/P>/gi, " ");
  s = crEntities(s, " ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim().replace(/\|/g, "/");
}

// 표 하나를 "| 셀 | 셀 |" 한 행 한 줄로 만든다. 셀 태그는 TD·TH(일반 표)와 TE·TU(재무제표 표) 넷이다.
function renderTable(inner: string): string {
  const rows: string[] = [];
  const trRe = /<TR\b[^>]*>([\s\S]*?)<\/TR>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(inner))) {
    const cells: string[] = [];
    const cellRe = /<(TD|TH|TE|TU)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(tr[1]))) {
      cells.push(c[3] !== undefined ? cellText(c[3]) : "");
      const span = parseInt(/COLSPAN\s*=\s*["']?(\d+)/i.exec(c[2])?.[1] ?? "1", 10);
      for (let k = 1; k < Math.min(span, 30); k++) cells.push("");
    }
    if (cells.some((x) => x !== "")) rows.push(`| ${cells.join(" | ")} |`);
  }
  return rows.join("\n");
}

function xmlToText(xml: string): string {
  let s = xml;
  s = s.replace(/<\?xml[^>]*>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "");
  // 머리말 메타값(서식 버전·추출 여부 Y/N 등) 제거: BODY 앞에서는 문서명·회사명만 남긴다.
  const bodyIdx = s.search(/<BODY\b/i);
  if (bodyIdx > 0) {
    const head = s.slice(0, bodyIdx);
    const keep = [/<DOCUMENT-NAME\b[^>]*>[\s\S]*?<\/DOCUMENT-NAME>/i, /<COMPANY-NAME\b[^>]*>[\s\S]*?<\/COMPANY-NAME>/i]
      .map((r) => r.exec(head)?.[0] ?? "")
      .filter(Boolean)
      .join("\n");
    s = keep + "\n" + s.slice(bodyIdx);
  }
  s = s.replace(/<SUMMARY\b[\s\S]*?<\/SUMMARY>/gi, "");
  s = s.replace(/<(FORMULA-VERSION|EXTRACTION)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/gi, "");
  // 원문 XML의 줄바꿈·들여쓰기는 의미가 없다(뷰어도 무시). 구조는 태그로만 만든다.
  s = s.replace(/[\r\n\t]+/g, " ");
  // 표는 따로 풀어 두었다가 마지막에 되돌린다.
  const tables: string[] = [];
  s = s.replace(/<TABLE\b[^>]*>([\s\S]*?)<\/TABLE>/gi, (_m, inner: string) => {
    tables.push(renderTable(inner));
    return `\n\n\u0000T${tables.length - 1}\u0000\n\n`;
  });
  // 짝이 안 맞아 남은 표 조각(중첩 표 등)은 예전 방식으로 푼다.
  s = s.replace(/<TR\b[^>]*>/gi, "\n| ");
  s = s.replace(/<\/(TD|TH|TE|TU)>/gi, " | ");
  // 제목·문단·줄바꿈
  s = s.replace(/<TITLE\b[^>]*>/gi, "\n\n## ");
  s = s.replace(/<\/TITLE>/gi, "\n");
  s = s.replace(/<(BR|PGBRK)\b[^>]*\/?>/gi, "\n");
  s = s.replace(/<\/(P|TR|SECTION-\d|LIBRARY|COVER-TITLE|DOCUMENT-NAME|COMPANY-NAME)>/gi, "\n");
  s = crEntities(s, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\u0000T(\d+)\u0000/g, (_m, i: string) => tables[Number(i)] ?? "");
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function docTitle(xml: string, fallback: string): string {
  const m = /<DOCUMENT-NAME\b[^>]*>([\s\S]*?)<\/DOCUMENT-NAME>/i.exec(xml);
  const t = m ? decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
  return t || fallback;
}

async function fetchDocument(rceptNo: string, apiKey: string): Promise<DocFile[]> {
  const buf = new Uint8Array(await getBinary("document", { rcept_no: rceptNo }, apiKey));
  // 정상 응답은 ZIP(PK). 아니면 오류 XML(status·message)이다.
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    const txt = decodeBytes(buf);
    const status = /<status>([^<]*)<\/status>/i.exec(txt)?.[1] ?? "";
    const message = /<message>([^<]*)<\/message>/i.exec(txt)?.[1] ?? txt.slice(0, 200);
    throw new Error(`[OpenDART] 공시 원문 조회 실패 (status ${status || "?"}): ${message}`);
  }
  const files = unzipSync(buf);
  const out: DocFile[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.xml$/i.test(name)) continue;
    const xml = decodeBytes(bytes);
    out.push({ name, title: docTitle(xml, name), text: xmlToText(xml) });
  }
  // 본문(접수번호.xml)이 먼저, 첨부(접수번호_00760.xml 등)는 뒤로
  out.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return out;
}

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "opendart_document",
    {
      title: "공시 원문 본문 (Disclosure Original Text)",
      description: `접수번호(rcept_no)로 DART 공시 원문을 받아 본문 텍스트로 반환합니다(OpenDART 공시서류원본파일 document.xml).
- 비상장 외감법인의 감사보고서도 됩니다. 순서: opendart_search_company로 corp_code → opendart_search_disclosure(pblntf_ty="F" 외부감사)로 감사보고서 접수번호 → 이 도구.
- 사업보고서처럼 첨부가 있는 공시는 ZIP 안에 파일이 여러 개입니다(본문, 감사보고서, 연결감사보고서 등). 결과 첫머리에 파일 목록이 나오고 file_index로 하나만 볼 수 있습니다.
- 본문이 길면 offset·max_chars로 나눠 받습니다. find에 검색어를 주면 해당 부분 주변만 모아서 줍니다(예: "재무상태표", "계속기업", "특수관계자").
- 표는 "| 셀 | 셀 |" 형태로 한 행을 한 줄에 풀어 둡니다(병합 셀은 빈칸으로 자리만 채움). 숫자 단위는 원문 표의 단위 표기를 따릅니다.`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14자리 접수번호 (opendart_search_disclosure 결과)"),
        file_index: z.number().int().min(0).optional().describe("ZIP 안 파일 번호(0부터). 생략하면 전체를 이어서 반환"),
        find: z.string().optional().describe("검색어. 주면 일치 부분 주변만 반환(공백으로 나눈 단어 중 하나라도 일치)"),
        offset: z.number().int().min(0).optional().describe("본문 시작 위치(문자 수, 기본 0)"),
        max_chars: z.number().int().min(1000).max(60000).optional().describe("반환 최대 문자 수(기본 15000, 최대 60000)"),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations,
    },
    async (params) => {
      try {
        const key = resolveApiKey(params.api_key);
        const files = await fetchDocument(params.rcept_no, key);
        if (!files.length) {
          return { content: [{ type: "text" as const, text: `접수번호 ${params.rcept_no}: ZIP 안에 XML 본문이 없습니다.` }] };
        }
        const L: string[] = [];
        L.push(`# 공시 원문 — 접수번호 ${params.rcept_no}`);
        L.push(`출처: OpenDART 공시서류원본파일(금융감독원) · https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${params.rcept_no}`);
        L.push("");
        L.push("## 파일 목록");
        files.forEach((f, i) => L.push(`- [${i}] ${f.title} (${f.name}, ${f.text.length.toLocaleString()}자)`));
        L.push("");

        const selected =
          params.file_index !== undefined
            ? files[params.file_index]
              ? [{ i: params.file_index, f: files[params.file_index] }]
              : []
            : files.map((f, i) => ({ i, f }));
        if (!selected.length) {
          L.push(`file_index ${params.file_index}에 해당하는 파일이 없습니다(0~${files.length - 1}).`);
          return { content: [{ type: "text" as const, text: L.join("\n") }], isError: true };
        }

        if (params.find && params.find.trim()) {
          const words = params.find.trim().split(/\s+/).filter(Boolean);
          const ctx = 600;
          const hits: string[] = [];
          let total = 0;
          for (const { i, f } of selected) {
            const lower = f.text.toLowerCase();
            const positions: number[] = [];
            for (const w of words) {
              let p = lower.indexOf(w.toLowerCase());
              while (p >= 0 && positions.length < 200) {
                positions.push(p);
                p = lower.indexOf(w.toLowerCase(), p + w.length);
              }
            }
            positions.sort((a, b) => a - b);
            total += positions.length;
            let lastEnd = -1;
            for (const p of positions) {
              if (hits.length >= 20) break;
              const start = Math.max(0, p - 200);
              if (start < lastEnd) continue;
              const end = Math.min(f.text.length, p + ctx);
              hits.push(`### [${i}] ${f.title} · offset ${start}\n${f.text.slice(start, end)}`);
              lastEnd = end;
            }
          }
          L.push(`## 검색 "${params.find}" — 출현 ${total}회${total >= 200 ? " 이상" : ""}, 구간 ${hits.length}곳${hits.length >= 20 ? "(20곳까지만 표시)" : ""} · 가까운 출현은 한 구간으로 묶음`);
          L.push(hits.length ? hits.join("\n\n---\n\n") : "일치하는 부분이 없습니다.");
          return { content: [{ type: "text" as const, text: L.join("\n") }] };
        }

        const joined = selected.map(({ i, f }) => `==== [${i}] ${f.title} ====\n${f.text}`).join("\n\n");
        const offset = params.offset ?? 0;
        const max = params.max_chars ?? 15000;
        const chunk = joined.slice(offset, offset + max);
        L.push(`## 본문 (${offset.toLocaleString()}~${(offset + chunk.length).toLocaleString()} / 전체 ${joined.length.toLocaleString()}자)`);
        L.push(chunk);
        if (offset + chunk.length < joined.length) {
          L.push("");
          L.push(`※ 이어서 받으려면 offset=${offset + chunk.length}${params.file_index !== undefined ? `, file_index=${params.file_index}` : ""}`);
        }
        return { content: [{ type: "text" as const, text: L.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
