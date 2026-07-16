(function () {
  const menuBtn = document.getElementById("menu-toggle");
  const nav = document.getElementById("site-nav");
  const tocBtn = document.getElementById("toc-toggle");
  const sidebar = document.getElementById("sidebar");

  if (menuBtn && nav) {
    menuBtn.addEventListener("click", () => {
      nav.classList.toggle("open");
    });
  }

  if (tocBtn && sidebar) {
    tocBtn.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });
  }

  // Highlight TOC links by scroll position
  const content = document.getElementById("doc-content");
  if (!content || !sidebar) return;

  const headings = content.querySelectorAll("h2[id], h3[id]");
  const links = sidebar.querySelectorAll(".toc a[href^='#']");
  if (!headings.length || !links.length) return;

  const byId = new Map();
  links.forEach((a) => {
    const id = a.getAttribute("href").slice(1);
    byId.set(id, a);
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.id;
        links.forEach((a) => a.classList.remove("active"));
        const link = byId.get(id);
        if (link) link.classList.add("active");
      });
    },
    { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
  );

  headings.forEach((h) => observer.observe(h));
})();
