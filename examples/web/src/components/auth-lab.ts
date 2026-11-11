import { TEST_CASES, executeCase } from "../tests";
import type { TestCtx } from "../tests";

const AUTH_CASE_IDS = [
  "auth-anon",
  "auth-guest",
  "auth-forbidden-sub",
  "auth-forbidden-req",
  "auth-ratelimit",
  "auth-revoke",
] as const;

/**
 * 鉴权实验室：六道关各一张卡，点按钮单独跑对应测试用例（与一键全测共用实现）。
 * 连接的是第二个基站实例（:8081，jwt 模式，需 npm run dev:server:jwt 启动）。
 */
export function mountAuthLab(root: HTMLElement, ctx: TestCtx): void {
  const cases = AUTH_CASE_IDS.map((id) => TEST_CASES.find((c) => c.id === id)!).filter(Boolean);
  const escapeHtml = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  root.innerHTML = `
    <div class="panel-head"><h2>鉴权五关点测 <span class="badge">每项独立签发令牌，互不干扰</span></h2></div>
    <p class="hint">每张卡点一次跑一次，签发的是该关专用的测试令牌（sub 以 tester- 开头），结果与证据就地显示。</p>
    <div class="lab-grid">
      ${cases
        .map(
          (c) => `
        <div class="lab-card" data-lab-card="${c.id}">
          <div class="lab-title">${escapeHtml(c.name)}</div>
          <button data-lab-run>点测</button>
          <div class="lab-result" data-lab-result>尚未运行</div>
        </div>`,
        )
        .join("")}
    </div>`;

  for (const testCase of cases) {
    const card = root.querySelector<HTMLElement>(`[data-lab-card="${testCase.id}"]`)!;
    const button = card.querySelector<HTMLButtonElement>("[data-lab-run]")!;
    const result = card.querySelector<HTMLElement>("[data-lab-result]")!;
    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true;
        result.textContent = "运行中…";
        card.dataset.status = "running";
        const r = await executeCase(testCase, ctx);
        card.dataset.status = r.ok ? "pass" : "fail";
        result.textContent = `${r.ok ? "✓ 通过" : "✗ 失败"}（${r.ms}ms）${r.evidence}`;
        button.disabled = false;
      })();
    });
  }
}
