(function () {
  "use strict";

  const selectors = {
    topbar: document.getElementById("topbar"),
    hero: document.getElementById("hero"),
    heroImage: document.querySelector(".hero-image"),
    heroMetrics: document.querySelectorAll(".hero-metric"),
    anchorLinks: document.querySelectorAll('a[href^="#"]'),
    reveals: document.querySelectorAll(
      ".reveal, .reveal-left, .reveal-right, .reveal-up, .method-card.reveal-child"
    )
  };

  let ticking = false;

  function updateHeroOffset() {
    const topbarHeight = selectors.topbar ? selectors.topbar.offsetHeight : 88;
    document.documentElement.style.setProperty("--hero-offset", `${topbarHeight + 20}px`);
  }

  function setReadyState() {
    window.requestAnimationFrame(() => {
      document.body.classList.add("page-ready");
    });
  }

  function setupScrollReveals() {
    if (!("IntersectionObserver" in window)) {
      selectors.reveals.forEach((element) => element.classList.add("visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        });
      },
      {
        threshold: 0.16,
        rootMargin: "0px 0px -8% 0px"
      }
    );

    selectors.reveals.forEach((element) => observer.observe(element));
  }

  function smoothScrollTo(target) {
    const topbarHeight = selectors.topbar ? selectors.topbar.offsetHeight : 88;
    const targetTop = target.getBoundingClientRect().top + window.scrollY;
    const destination = Math.max(0, targetTop - topbarHeight - 18);

    window.scrollTo({
      top: destination,
      behavior: "smooth"
    });
  }

  function setupSmoothScroll() {
    selectors.anchorLinks.forEach((anchor) => {
      anchor.addEventListener("click", (event) => {
        const href = anchor.getAttribute("href");
        if (!href || href === "#") {
          return;
        }

        const target = document.querySelector(href);
        if (!target) {
          return;
        }

        event.preventDefault();
        smoothScrollTo(target);
      });
    });
  }

  function updateScrollState() {
    const scrollY = window.scrollY || window.pageYOffset;

    if (selectors.topbar) {
      selectors.topbar.classList.toggle("is-scrolled", scrollY > 24);
    }

    if (!selectors.hero || !selectors.heroImage) {
      return;
    }

    const heroHeight = selectors.hero.offsetHeight || 1;
    const progress = Math.min(scrollY / heroHeight, 1);
    const translateY = progress * 22;
    const scale = 1.04 + progress * 0.035;
    selectors.heroImage.style.transform = `translate3d(0, ${translateY}px, 0) scale(${scale})`;

    selectors.heroMetrics.forEach((metric, index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      const offset = progress * (8 + index * 2) * direction;
      if (offset === 0) {
        metric.style.removeProperty('transform');
      } else {
        metric.style.transform = `translate3d(0, ${offset}px, 0)`;
      }
    });
  }

  function handleScroll() {
    if (ticking) {
      return;
    }

    ticking = true;
    window.requestAnimationFrame(() => {
      updateScrollState();
      ticking = false;
    });
  }

  function init() {
    updateHeroOffset();
    setupScrollReveals();
    setupSmoothScroll();
    setReadyState();
    updateScrollState();

    window.addEventListener("resize", updateHeroOffset);
    window.addEventListener("scroll", handleScroll, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
