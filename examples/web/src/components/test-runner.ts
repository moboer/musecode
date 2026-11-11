import { TEST_CASES, executeCase } from "../tests";
import type { TestCtx } from "../tests";

/**
 * 一键全测：把 tests.ts 的全部用例渲染成结果列表，点按钮顺序执行，
 * 每项实时更新状态（运行中/✓/✗）、证据与耗时，顶部汇总通过数。
 */
export function mountTestBench(ctx: TestCtx): void {
  const button = document.querySelector<HTMLButtonElement>("[data-run-all]")!;
  const list = document.querySelector<HTMLElement>("[data-bench-results]")!;
  const summary = document.querySelector<HTMLElement>("[data-bench-summary]")!;

  const escapeHtml = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  list.innerHTML = TEST_CASES.map(
    (c) => `
    <li class="bench-item" data-bench-item="${c.id}">
      <span class="bench-state" data-state>待测</span>
      <span class="bench-name"><em>${escapeHtml(c.group)}</em>${escapeHtml(c.name)}</span>
      <span class="bench-evidence" data-evidence></span>
      <span class="bench-ms" data-ms></span>
    </li>`,
  ).join("");

  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true;
      let passed = 0;
      for (const testCase of TEST_CASES) {
        const item = list.querySelector<HTMLElement>(`[data-bench-item="${testCase.id}"]`)!;
        const state = item.querySelector<HTMLElement>("[data-state]")!;
        const evidence = item.querySelector<HTMLElement>("[data-evidence]")!;
        const ms = item.querySelector<HTMLElement>("[data-ms]")!;
        state.textContent = "运行中";
        item.dataset.status = "running";
        item.scrollIntoView({ block: "nearest", behavior: "smooth" });
        const result = await executeCase(testCase, ctx);
        state.textContent = result.ok ? "✓ 通过" : "✗ 失败";
        item.dataset.status = result.ok ? "pass" : "fail";
        evidence.textContent = result.evidence;
        ms.textContent = `${result.ms}ms`;
        if (result.ok) passed++;
        summary.textContent = `进度 ${passed}/${TEST_CASES.length} 通过…`;
      }
      summary.textContent = `完成：${passed}/${TEST_CASES.length} 通过`;
      button.disabled = false;
    })();
  });
}
