import { CORP_CLS_MAP, REPORT_CODES } from "./types";

export function formatNumber(val: string | number | undefined): string {
  if (val === undefined || val === null || val === "" || val === "-") return "-";
  const num = typeof val === "string" ? parseInt(val.replace(/,/g, ""), 10) : val;
  if (isNaN(num)) return String(val);
  return num.toLocaleString("ko-KR");
}

export function formatCorpCls(cls: string): string {
  return CORP_CLS_MAP[cls] || cls;
}

export function formatReportCode(code: string): string {
  return REPORT_CODES[code] || code;
}

export function formatCompanyInfoMd(info: Record<string, unknown>): string {
  const lines = [
    `## ${info.corp_name} (${info.corp_name_eng || ""})`,
    "",
    `| 항목 | 내용 |`,
    `|------|------|`,
    `| 종목코드 (Stock Code) | ${info.stock_code || "비상장"} |`,
    `| 시장 (Market) | ${formatCorpCls(String(info.corp_cls || ""))} |`,
    `| 대표이사 (CEO) | ${info.ceo_nm || "-"} |`,
    `| 법인등록번호 | ${info.jurir_no || "-"} |`,
    `| 사업자등록번호 | ${info.bizr_no || "-"} |`,
    `| 주소 (Address) | ${info.adres || "-"} |`,
    `| 홈페이지 | ${info.hm_url || "-"} |`,
    `| 전화번호 | ${info.phn_no || "-"} |`,
    `| 업종코드 | ${info.induty_code || "-"} |`,
    `| 설립일 (Est.) | ${info.est_dt || "-"} |`,
    `| 결산월 (Fiscal) | ${info.acc_mt || "-"}월 |`,
  ];
  return lines.join("\n");
}

export function formatDisclosureListMd(
  items: Array<Record<string, unknown>>,
  totalCount: number,
  page: number,
  totalPage: number
): string {
  if (!items || items.length === 0) {
    return "No disclosures found. / 조회된 공시가 없습니다.";
  }

  const lines = [
    `## 공시 검색 결과 (Disclosure Search Results)`,
    `총 ${totalCount}건 중 ${page}/${totalPage} 페이지`,
    "",
    `| 날짜 | 회사명 | 보고서명 | 접수번호 |`,
    `|------|--------|----------|----------|`,
  ];

  for (const item of items) {
    lines.push(
      `| ${item.rcept_dt} | ${item.corp_name} (${formatCorpCls(String(item.corp_cls))}) | ${item.report_nm} | ${item.rcept_no} |`
    );
  }

  return lines.join("\n");
}

export interface FinancialTableOptions {
  groupByFsDiv?: boolean;
}

function hasAmount(val: unknown): boolean {
  if (typeof val !== "string") return false;
  const v = val.trim();
  return v !== "" && v !== "-";
}

function renderFinancialRows(
  items: Array<Record<string, unknown>>,
  title: string
): string {
  const first = items[0];
  const hasThreeTerms = first.bfefrmtrm_amount !== undefined;
  // 분·반기 보고서의 손익 항목은 당기(해당 분기 3개월)와 누적 금액을 따로 준다.
  // 누적 칸을 빼면 3개월치가 반기·분기 누적 실적처럼 읽히므로 함께 싣는다.
  const hasCumulative = items.some((i) => hasAmount(i.thstrm_add_amount));

  const lines = [`### ${title}`, ""];

  if (hasCumulative) {
    lines.push(
      `> 분·반기 손익: '당기'는 해당 분기 3개월, '당기 누적'은 사업연도 개시일부터의 누적. 재무상태표의 '전기'는 전기말 기준.`,
      "",
      `| 재무제표 | 계정명 | 당기 | 당기 누적 | 전기 | 전기 누적 |`,
      `|----------|--------|------|-----------|------|-----------|`
    );
    for (const item of items) {
      lines.push(
        `| ${item.sj_nm} | ${item.account_nm} | ${formatNumber(item.thstrm_amount as string)} | ${formatNumber(item.thstrm_add_amount as string)} | ${formatNumber(item.frmtrm_amount as string)} | ${formatNumber(item.frmtrm_add_amount as string)} |`
      );
    }
  } else if (hasThreeTerms) {
    lines.push(
      `| 재무제표 | 계정명 | 당기 (${first.thstrm_nm || "Current"}) | 전기 (${first.frmtrm_nm || "Prior"}) | 전전기 (${first.bfefrmtrm_nm || "Pre-Prior"}) |`,
      `|----------|--------|------|------|--------|`
    );
    for (const item of items) {
      lines.push(
        `| ${item.sj_nm} | ${item.account_nm} | ${formatNumber(item.thstrm_amount as string)} | ${formatNumber(item.frmtrm_amount as string)} | ${formatNumber(item.bfefrmtrm_amount as string)} |`
      );
    }
  } else {
    lines.push(
      `| 재무제표 | 계정명 | 당기 | 전기 |`,
      `|----------|--------|------|------|`
    );
    for (const item of items) {
      lines.push(
        `| ${item.sj_nm} | ${item.account_nm} | ${formatNumber(item.thstrm_amount as string)} | ${formatNumber(item.frmtrm_amount as string)} |`
      );
    }
  }

  return lines.join("\n");
}

export function formatFinancialTableMd(
  items: Array<Record<string, unknown>>,
  title: string,
  options: FinancialTableOptions = {}
): string {
  if (!items || items.length === 0) {
    return `## ${title}\nNo data available. / 데이터가 없습니다.`;
  }

  const { groupByFsDiv = true } = options;

  if (groupByFsDiv) {
    const cfs = items.filter(i => i.fs_div === "CFS");
    const ofs = items.filter(i => i.fs_div === "OFS");

    if (cfs.length > 0 && ofs.length > 0) {
      const sections = [`## ${title}`];
      sections.push("", renderFinancialRows(cfs, "연결재무제표 (Consolidated)"));
      sections.push("", renderFinancialRows(ofs, "별도재무제표 (Separate)"));
      return sections.join("\n");
    }
  }

  return `## ${title}\n\n${renderFinancialRows(items, title)}`;
}

export function formatGenericTableMd(
  items: Array<Record<string, unknown>>,
  title: string,
  columns: Array<{ key: string; label: string }>
): string {
  if (!items || items.length === 0) {
    return `## ${title}\nNo data available. / 데이터가 없습니다.`;
  }

  const header = columns.map((c) => c.label).join(" | ");
  const separator = columns.map(() => "------").join(" | ");

  const lines = [
    `## ${title}`,
    "",
    `| ${header} |`,
    `| ${separator} |`,
  ];

  for (const item of items) {
    const row = columns.map((c) => String(item[c.key] ?? "-")).join(" | ");
    lines.push(`| ${row} |`);
  }

  return lines.join("\n");
}

export function formatPagination(page: number, totalCount: number, totalPage: number): string {
  return `\n---\nPage ${page}/${totalPage} (Total: ${totalCount})`;
}
