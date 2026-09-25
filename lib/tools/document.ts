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
  xml: string;
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

// 굵은 글씨 SPAN(USERMARK="B")은 주석 제목이다. 문단 안에 본문과 이어 붙어 있어도 제목 앞뒤로 줄을 나눈다.
// USERMARK="!B"(굵게 해제)로 시작하는 SPAN은 제목 뒤 본문의 시작이다. 줄 나눔 자리는 \u0001로 표시해 두고 나중에 바꾼다.
function markBoldSpans(s: string): string {
  return s.replace(/<SPAN\b([^>]*)>([\s\S]*?)<\/SPAN>/gi, (_m, attrs: string, inner: string) => {
    const um = /USERMARK\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    const tokens = um.split(/\s+/);
    if (tokens.includes("B")) return `\u0001${inner}\u0001`;
    if (tokens.includes("!B")) return `\u0001${inner}`;
    return inner;
  });
}

// 셀 안의 문단·줄바꿈은 공백으로 이어 붙인다(한 행이 한 줄에 오도록). keepBreaks면 줄바꿈을 살린다(1열 설명 표용).
function cellText(inner: string, keepBreaks = false): string {
  const br = keepBreaks ? "\n" : " ";
  let s = inner.replace(/\n/g, br).replace(/<(BR|PGBRK)\b[^>]*\/?>/gi, br).replace(/<\/?P\b[^>]*>/gi, br);
  s = crEntities(s, br);
  s = s.replace(/\u0001/g, br);
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/\r\n?|[\u2028\u2029\u0085\u000b\u000c]/g, br);
  if (keepBreaks) {
    return s
      .split("\n")
      .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }
  return s.replace(/\s+/g, " ").trim().replace(/\|/g, "/");
}

// 표 하나를 "| 셀 | 셀 |" 한 행 한 줄로 만든다. 셀 태그는 TD·TH(일반 표)와 TE·TU(재무제표 표) 넷이다.
// COLSPAN은 빈칸으로 자리를 채우고, ROWSPAN은 아래 행에 같은 값을 채워 열이 밀리지 않게 한다.
// 모든 행에 값이 한 칸뿐인 표(주석 설명을 1열 표로 감싼 경우)는 표가 아니라 문단으로 푼다.
function renderTable(inner: string): string {
  const grid: string[][] = [];
  const textual: string[] = [];
  let maxFilled = 0;
  const pending = new Map<number, { v: string; left: number }>();
  const trRe = /<TR\b[^>]*>([\s\S]*?)<\/TR>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(inner))) {
    const row: string[] = [];
    let col = 0;
    const fillPending = () => {
      let p = pending.get(col);
      while (p && p.left > 0) {
        row.push(p.v);
        p.left -= 1;
        if (p.left <= 0) pending.delete(col);
        col += 1;
        p = pending.get(col);
      }
    };
    const cellRe = /<(TD|TH|TE|TU)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
    let c: RegExpExecArray | null;
    const rowTexts: string[] = [];
    while ((c = cellRe.exec(tr[1]))) {
      fillPending();
      const body = c[3] ?? "";
      const txt = body ? cellText(body) : "";
      if (txt) rowTexts.push(cellText(body, true));
      const cs = Math.min(parseInt(/COLSPAN\s*=\s*["']?(\d+)/i.exec(c[2])?.[1] ?? "1", 10) || 1, 30);
      const rs = Math.min(parseInt(/ROWSPAN\s*=\s*["']?(\d+)/i.exec(c[2])?.[1] ?? "1", 10) || 1, 200);
      for (let k = 0; k < cs; k++) {
        const v = k === 0 ? txt : "";
        row.push(v);
        if (rs > 1) pending.set(col, { v, left: rs - 1 });
        col += 1;
      }
    }
    fillPending();
    const filled = new Set(row.filter((x) => x !== "")).size;
    if (!filled) continue;
    maxFilled = Math.max(maxFilled, filled);
    grid.push(row);
    textual.push(rowTexts.join("\n"));
  }
  if (maxFilled <= 1) return textual.filter(Boolean).join("\n");
  return grid.map((r) => `| ${r.join(" | ")} |`).join("\n");
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
  // 태그 사이의 줄바꿈·들여쓰기(서식용)는 지운다. 글자 사이의 줄바꿈은 DART 뷰어가 <BR>로 보여주므로 줄바꿈으로 살린다.
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/>[ \t]*\n\s*</g, "><");
  s = s.replace(/\t/g, " ");
  s = markBoldSpans(s);
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
  // 문단은 여는 태그에서도 줄을 바꾼다(닫는 태그 없이 이어지는 문단 대비).
  s = s.replace(/<P\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(P|TR|SECTION-\d|LIBRARY|COVER-TITLE|DOCUMENT-NAME|COMPANY-NAME)>/gi, "\n");
  s = crEntities(s, "\n");
  s = s.replace(/\u0001/g, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // 숫자 엔티티(&#13; 등)로 들어온 줄바꿈 문자도 줄바꿈으로 통일한다.
  s = s.replace(/\r\n?|[\u2028\u2029\u0085\u000b\u000c]/g, "\n");
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
    out.push({ name, title: docTitle(xml, name), text: xmlToText(xml), xml });
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
- 표는 "| 셀 | 셀 |" 형태로 한 행을 한 줄에 풀어 둡니다(가로 병합 셀은 빈칸, 세로 병합 셀은 같은 값으로 채움). 값이 한 칸뿐인 설명용 표는 문단으로 풉니다. 숫자 단위는 원문 표의 단위 표기를 따릅니다.`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14자리 접수번호 (opendart_search_disclosure 결과)"),
        file_index: z.number().int().min(0).optional().describe("ZIP 안 파일 번호(0부터). 생략하면 전체를 이어서 반환"),
        find: z.string().optional().describe("검색어. 주면 일치 부분 주변만 반환. 여러 단어면 먼저 구절 전체로 찾고, 없을 때만 단어 중 하나라도 일치로 넓힘. 원문의 글자 사이 띄어쓰기는 무시"),
        raw: z.boolean().optional().describe("true면 find 주변의 원문 XML을 가공 없이 반환(파서 점검용, 최대 5곳)"),
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
          // 원문 제목이 "재 무 상 태 표"처럼 띄어 쓰인 경우도 잡도록 글자 사이 공백을 허용한다.
          const charPattern = (w: string) =>
            Array.from(w.toLowerCase())
              .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("\\s*");
          const phrase = words.map(charPattern).join("\\s*");
          const collect = (hay: string, patterns: string[], limit: number) => {
            const positions: number[] = [];
            for (const pat of patterns) {
              const re = new RegExp(pat, "g");
              let m: RegExpExecArray | null;
              while ((m = re.exec(hay)) && positions.length < limit) {
                positions.push(m.index);
                if (m[0].length === 0) re.lastIndex += 1;
              }
            }
            return positions.sort((x, y) => x - y);
          };

          if (params.raw) {
            // 원문 XML에서는 태그·공백이 글자 사이에 낄 수 있으므로 그것을 건너뛰며 구절 전체로 찾는다. BODY 앞(머리말)은 제외.
            const gap = "(?:\\s|<[^>]*>)*";
            const rawPhrase = Array.from(words.join("").toLowerCase())
              .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join(gap);
            const raws: string[] = [];
            let rawMode = "구절 일치";
            const scan = (pats: string[]) => {
              raws.length = 0;
              for (const { i, f } of selected) {
                const lowerXml = f.xml.toLowerCase();
                const bodyAt = Math.max(0, lowerXml.search(/<body\b/));
                let lastEnd = -1;
                for (const p of collect(lowerXml, pats, 400)) {
                  if (raws.length >= 5) break;
                  if (p < bodyAt) continue;
                  const start = Math.max(0, p - 300);
                  if (start < lastEnd) continue;
                  const end = Math.min(f.xml.length, p + 1200);
                  raws.push(`### [${i}] ${f.title} · 원문 XML offset ${start}\n${f.xml.slice(start, end)}`);
                  lastEnd = end;
                }
              }
            };
            scan([rawPhrase]);
            if (!raws.length && words.length > 1) {
              rawMode = "구절 없음 → 단어 중 하나라도 일치";
              scan(words.map((w) => w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            }
            L.push(`## 원문 XML "${params.find}" (${rawMode}) — ${raws.length}곳(최대 5곳, 본문만)`);
            L.push(raws.length ? raws.join("\n\n---\n\n") : "일치하는 부분이 없습니다.");
            return { content: [{ type: "text" as const, text: L.join("\n") }] };
          }

          const ctx = 600;
          const hits: string[] = [];
          let total = 0;
          let mode = words.length > 1 ? "구절 일치" : "일치";
          const run = (patterns: string[]) => {
            hits.length = 0;
            total = 0;
            for (const { i, f } of selected) {
              const positions = collect(f.text.toLowerCase(), patterns, 200);
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
          };
          run([phrase]);
          if (total === 0 && words.length > 1) {
            mode = "구절 없음 → 단어 중 하나라도 일치";
            run(words.map(charPattern));
          }
          L.push(`## 검색 "${params.find}" (${mode}) — 출현 ${total}회${total >= 200 ? " 이상" : ""}, 구간 ${hits.length}곳${hits.length >= 20 ? "(20곳까지만 표시)" : ""} · 가까운 출현은 한 구간으로 묶음`);
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
