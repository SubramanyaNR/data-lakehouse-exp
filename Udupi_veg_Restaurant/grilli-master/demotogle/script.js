document.addEventListener("DOMContentLoaded", function () {

  // MENU OPEN / CLOSE
  const menuBtn = document.getElementById("menuBtn");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      document.body.classList.toggle("nav-active");
      console.log("Menu clicked");
    });
  }

  // SUBMENU TOGGLE
  document.querySelectorAll(".nav-toggle").forEach(btn => {
    btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation(); 
        
        this.parentElement.classList.toggle("active");
        console.log("Submenu toggled");
    });
});
});