import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ArgusAgent } from "../src/agents/index.js";
import { CsrcPublicFundProductProvider, SourceRegistry } from "../src/dataSources/index.js";

const execFileAsync = promisify(execFile);

const csrcProductIndexPage = `
<html>
  <head><meta name="ArticleTitle" content="公募基金产品索引（截至20260131）"/></head>
  <body>
    <h2>公募基金产品索引（截至20260131）</h2>
    <div id="files">
      <a href="1029655/files/公募基金产品索引（截至20260131）.xlsx" target="_blank">公募基金产品索引（截至20260131）.xlsx</a>
    </div>
  </body>
</html>
`;

const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="9" uniqueCount="9">
  <si><t>基金产品索引</t></si>
  <si><t>序号</t></si>
  <si><t>基金代码</t></si>
  <si><t>基金简称</t></si>
  <si><t>设立日期</t></si>
  <si><t>招商信用增强债券C</t></si>
  <si><t>交银中证海外中国互联网指数QDII</t></si>
  <si><t>华夏成长混合</t></si>
</sst>`;

const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c><c r="D2" t="s"><v>4</v></c></row>
    <row r="3"><c r="A3"><v>1</v></c><c r="B3"><v>7951</v></c><c r="C3" t="s"><v>5</v></c><c r="D3"><v>45292</v></c></row>
    <row r="4"><c r="A4"><v>2</v></c><c r="B4"><v>164906</v></c><c r="C4" t="s"><v>6</v></c><c r="D4"><v>44928</v></c></row>
    <row r="5"><c r="A5"><v>3</v></c><c r="B5"><v>1</v></c><c r="C5" t="s"><v>7</v></c><c r="D5"><v>37243</v></c></row>
  </sheetData>
</worksheet>`;

test("CsrcPublicFundProductProvider parses official product-index link", () => {
  const link = CsrcPublicFundProductProvider.parseAttachmentLink(csrcProductIndexPage, "https://www.csrc.gov.cn/csrc/c101900/c1029655/content.shtml");

  assert.equal(link?.title, "公募基金产品索引（截至20260131）.xlsx");
  assert.equal(
    link?.url,
    "https://www.csrc.gov.cn/csrc/c101900/c1029655/1029655/files/%E5%85%AC%E5%8B%9F%E5%9F%BA%E9%87%91%E4%BA%A7%E5%93%81%E7%B4%A2%E5%BC%95%EF%BC%88%E6%88%AA%E8%87%B320260131%EF%BC%89.xlsx"
  );
  assert.equal(CsrcPublicFundProductProvider.asOfDateFrom(csrcProductIndexPage), "2026-01-31");
});

test("CsrcPublicFundProductProvider parses minimal XLSX product rows", async () => {
  const xlsx = await buildMinimalXlsx();
  const products = await CsrcPublicFundProductProvider.parseXlsxProducts(xlsx);

  assert.equal(products.length, 3);
  assert.deepEqual(products[0], {
    sequence: 1,
    fund_code: "007951",
    fund_name: "招商信用增强债券C",
    established_at: "2024-01-01"
  });
  assert.equal(products[1]?.fund_type, undefined);
  assert.equal(products[1]?.fund_code, "164906");
  assert.equal(products[1]?.established_at, "2023-01-02");
});

test("CsrcPublicFundProductProvider returns official fund metadata without advice", async () => {
  const xlsx = await buildMinimalXlsx();
  const xlsxUrl =
    "https://www.csrc.gov.cn/csrc/c101900/c1029655/1029655/files/%E5%85%AC%E5%8B%9F%E5%9F%BA%E9%87%91%E4%BA%A7%E5%93%81%E7%B4%A2%E5%BC%95%EF%BC%88%E6%88%AA%E8%87%B320260131%EF%BC%89.xlsx";
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/content.shtml")) {
      return new Response(csrcProductIndexPage, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (target === xlsxUrl) {
      return new Response(xlsx, {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await new CsrcPublicFundProductProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["fund_meta"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "csrc-public-fund-products");
  assert.equal(result.source_type, "fund_meta");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_code, "007951");
  assert.equal(result.data?.fund_name, "招商信用增强债券C");
  assert.equal(result.data?.fund_type, "bond");
  assert.ok(result.data?.themes?.includes("信用"));
  assert.match(result.raw_reference ?? "", /csrc\.gov\.cn\/csrc\/c101900\/c1029655/);
  assert.ok(result.warnings.some((warning) => warning.includes("仅提供官方基金元数据")));
  assert.doesNotMatch(JSON.stringify(result), /trial_buy|staged_buy|\b(buy|sell)\b/i);
});

test("CsrcPublicFundProductProvider fails explicitly when fund code is absent", async () => {
  const xlsx = await buildMinimalXlsx();
  const fetchImpl = (async (url: string | URL | Request) =>
    String(url).endsWith("/content.shtml")
      ? new Response(csrcProductIndexPage, { status: 200, headers: { "content-type": "text/html" } })
      : new Response(xlsx, {
          status: 200,
          headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
        })) as typeof fetch;

  const result = await new CsrcPublicFundProductProvider(fetchImpl, 1000).fetch({
    fund_code: "999999",
    required_data: ["fund_meta"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /999999/);
  assert.ok(result.warnings.some((warning) => warning.includes("未找到该基金代码")));
});

test("Argus preserves CSRC official fund metadata but blocks analysis without NAV", async () => {
  const xlsx = await buildMinimalXlsx();
  const fetchImpl = (async (url: string | URL | Request) =>
    String(url).endsWith("/content.shtml")
      ? new Response(csrcProductIndexPage, { status: 200, headers: { "content-type": "text/html" } })
      : new Response(xlsx, {
          status: 200,
          headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
        })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new CsrcPublicFundProductProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("csrc-product-flow", "007951");

  assert.equal(dataPack.fund_name, "招商信用增强债券C");
  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.ok(dataPack.data_quality_report.missing_core_fields.includes("current_nav"));
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "csrc-public-fund-products" && source.record_count === null));
});

async function buildMinimalXlsx(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "fundsentinel-csrc-products-"));
  try {
    await mkdir(join(dir, "xl", "worksheets"), { recursive: true });
    await mkdir(join(dir, "xl", "_rels"), { recursive: true });
    await mkdir(join(dir, "_rels"), { recursive: true });
    await writeFile(join(dir, "[Content_Types].xml"), contentTypesXml);
    await writeFile(join(dir, "_rels", ".rels"), rootRelsXml);
    await writeFile(join(dir, "xl", "workbook.xml"), workbookXml);
    await writeFile(join(dir, "xl", "_rels", "workbook.xml.rels"), workbookRelsXml);
    await writeFile(join(dir, "xl", "sharedStrings.xml"), sharedStringsXml);
    await writeFile(join(dir, "xl", "worksheets", "sheet1.xml"), sheetXml);

    await execFileAsync("zip", ["-qr", "product-index.xlsx", "[Content_Types].xml", "_rels", "xl"], { cwd: dir });
    return await readFile(join(dir, "product-index.xlsx"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;
