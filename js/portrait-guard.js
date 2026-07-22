(function() {
    const PORTRAIT_GUARD_DISMISSED_KEY = 'portraitGuardDismissed';
    const portraitGuard = document.getElementById('portrait-mode-guard');
    const continueBtn = document.getElementById('continueInPortraitBtn');
    const dismissCheckbox = document.getElementById('portraitGuardDismissCheckbox');

    if (!portraitGuard || !continueBtn) return;

    // Check whether this guard is currently dismissed
    let isDismissed = false;
    try {
        isDismissed = localStorage.getItem(PORTRAIT_GUARD_DISMISSED_KEY) === 'true';
    } catch(e) {
        // localStorage not available (private mode, security settings, etc.)
    }
    if (isDismissed) {
        portraitGuard.style.display = 'none';
    }

    // Handle continue button click
    continueBtn.addEventListener('click', () => {
        // Persist the dismissal when "Don't show again" is checked
        if (dismissCheckbox && dismissCheckbox.checked) {
            try {
                localStorage.setItem(PORTRAIT_GUARD_DISMISSED_KEY, 'true');
            } catch(e) {
                // localStorage not available - ignore
            }
        }
        // Hide the guard
        portraitGuard.style.display = 'none';
    });
})();
