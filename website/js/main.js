// Stegstr website - platform highlight for download buttons
document.addEventListener('DOMContentLoaded', function() {
  const downloadSection = document.querySelector('.download-buttons');
  if (downloadSection) {
    var userAgent = navigator.userAgent.toLowerCase();
    var isMac = userAgent.includes('mac');
    var isWin = userAgent.includes('win');
    var isLinux = userAgent.includes('linux') && !userAgent.includes('android');
    if (isMac || isWin || isLinux) {
      var preferredBtn = downloadSection.querySelector(
        isMac ? '[data-platform="mac"]' :
        isWin ? '[data-platform="win"]' :
        '[data-platform="linux"]'
      );
      if (preferredBtn) preferredBtn.classList.add('preferred');
    }
  }

  // Copy-to-clipboard for CLI commands
  document.querySelectorAll('.copy-cmd-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var text = btn.getAttribute('data-copy') || (btn.previousElementSibling && btn.previousElementSibling.textContent) || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(function() {
        var label = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = label; }, 1500);
      });
    });
  });
});
