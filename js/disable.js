// ===============================
// Disable Inspect - SAFE VERSION
// ===============================

// Disable F12, Ctrl+U, Ctrl+I
document.addEventListener("keydown", function (e) {
  if (
    e.key === "F12" ||
    (e.ctrlKey && e.key.toLowerCase() === "u") ||
    (e.ctrlKey && e.key.toLowerCase() === "i")
  ) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
});

// Disable right click
document.addEventListener("contextmenu", function (e) {
  e.preventDefault();
});

// Optional: warning in console (aman)
console.log(
  "%cSTOP!",
  "color:red;font-size:32px;font-weight:bold;"
);
console.log(
  "%cInspect dinonaktifkan.",
  "font-size:14px;"
);
