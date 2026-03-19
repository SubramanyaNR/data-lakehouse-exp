const menuBtn = document.getElementById("menuBtn");
const nav = document.querySelector(".nav");

/* MENU TOGGLE */
menuBtn.onclick = (e) => {
  e.stopPropagation(); // 🔑 prevent auto-close
  document.body.classList.toggle("nav-active");
};

/* CLICK OUTSIDE TO CLOSE MENU */
document.addEventListener("click", (e) => {
  if (
    document.body.classList.contains("nav-active") &&
    !nav.contains(e.target) &&
    !menuBtn.contains(e.target)
  ) {
    document.body.classList.remove("nav-active");
  }
});

/* SUB MENU TOGGLE */
document.querySelectorAll(".nav-toggle").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    btn.parentElement.classList.toggle("active");
  });
});

function showPage(id) {
  document.querySelectorAll(".page").forEach(p => {
    p.classList.remove("active");
  });

  const page = document.getElementById(id);
  if (page) {
    page.classList.add("active");
    window.scrollTo(0, 0);
  }

  document.body.classList.remove("nav-active");
}
document.querySelectorAll("[data-page]").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    showPage(link.dataset.page);
  });
});

/* MAIN MENU CLICK */
document.querySelectorAll(".nav-toggle").forEach(btn => {
  btn.addEventListener("click", e => {
    e.stopPropagation();
    showPage(btn.dataset.page);
    btn.parentElement.classList.toggle("active");
  });
});

/* SUB MENU CLICK */
document.querySelectorAll(".sub-menu a").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    showPage(link.dataset.page);
  });
});


/* DARK / LIGHT */
document.getElementById("themeSwitch").onclick = (e) => {
  e.stopPropagation();
  document.body.classList.toggle("light");
};
