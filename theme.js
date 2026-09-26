// 라이트/다크 전환. 직접 고른 적 없으면 시스템 설정을 따름 (MOCHESTRA 공통 키 사용)
(() => {
  const STORAGE_KEY = "mochestra-theme";
  const root = document.documentElement;
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const button = document.getElementById("theme-toggle");

  const current = () => root.dataset.theme || (darkQuery.matches ? "dark" : "light");

  function render() {
    const isDark = current() === "dark";
    button.innerHTML = `<span aria-hidden="true">${isDark ? "☀" : "☾"}</span>${isDark ? "라이트" : "다크"}`;
    button.setAttribute("aria-label", isDark ? "라이트 모드로 전환" : "다크 모드로 전환");
  }

  button.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 저장이 막혀 있어도 이번 화면에서는 전환됨
    }
    render();
  });

  darkQuery.addEventListener("change", () => {
    if (!root.dataset.theme) render();
  });

  render();
})();
