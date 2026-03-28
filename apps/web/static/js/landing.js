/* 12 Reader Landing Page – Scroll Reveals & Interactions */

(function() {
  'use strict';

  // Scroll-triggered reveals using IntersectionObserver
  const setupScrollReveals = () => {
    const observerOptions = {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          // Unobserve after reveal to prevent re-triggering
          observer.unobserve(entry.target);
        }
      });
    }, observerOptions);

    // Observe all reveal elements
    document.querySelectorAll('.reveal').forEach((el) => {
      observer.observe(el);
    });
  };

  // Newsletter form submission
  const setupNewsletter = () => {
    const form = document.querySelector('.newsletter-form');
    if (!form) return;

    form.addEventListener('submit', (e) => {
      e.preventDefault();

      const input = form.querySelector('input[type="email"]');
      const button = form.querySelector('button');
      const email = input.value;

      // Show success state
      const originalText = button.textContent;
      button.textContent = '✓ Subscribed!';
      button.style.background = 'var(--accent)';
      button.style.color = 'white';
      button.disabled = true;

      // Reset form after 2 seconds
      setTimeout(() => {
        form.reset();
        button.textContent = originalText;
        button.style.background = '';
        button.style.color = '';
        button.disabled = false;
        input.focus();
      }, 2000);
    });
  };

  // Smooth scroll for anchor links
  const setupSmoothScroll = () => {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', (e) => {
        const href = anchor.getAttribute('href');
        if (href === '#') return; // Skip nav CTA buttons

        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  };

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupScrollReveals();
      setupNewsletter();
      setupSmoothScroll();
    });
  } else {
    // Already loaded
    setupScrollReveals();
    setupNewsletter();
    setupSmoothScroll();
  }

  // Fallback for newsletter submit if inline handler fails
  function handleNewsletterSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button');
    const originalText = button.textContent;

    button.textContent = '✓ Subscribed!';
    button.style.background = 'var(--accent)';
    button.style.color = 'white';
    button.disabled = true;

    setTimeout(() => {
      form.reset();
      button.textContent = originalText;
      button.style.background = '';
      button.style.color = '';
      button.disabled = false;
    }, 2000);
  }

  // Make handler globally available for inline onsubmit
  window.handleNewsletterSubmit = handleNewsletterSubmit;

})();
