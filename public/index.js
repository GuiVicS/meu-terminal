import TerminalManager from "./managers/terminal.js";
import ServiceWorkerManager from "./managers/serviceWorker.js";

document.addEventListener('DOMContentLoaded', () => {
    let serviceWorkerManager;
    
    async function waitForFonts() {
        // Create a promise that resolves when fonts are loaded
        const fontPromises = [
            'FiraCode Nerd Font',
        ].map(font => document.fonts.load(`1em "${font}"`));

        try {
            await Promise.all(fontPromises);
        } catch (e) {
            console.warn('Font loading error:', e);
        }
    }

    // Add logout functionality
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            fetch(joinPath('logout'), {
                method: 'POST',
                credentials: 'same-origin'
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    window.location.reload();
                }
            })
            .catch(error => {
                console.error('Logout failed:', error);
            });
        });
    }

    // Theme toggle functionality
    function initThemeToggle() {
        const themeToggle = document.getElementById('themeToggle');

        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }

    // Helper function to join paths with base path
    function joinPath(path) {
        const basePath = window.appConfig?.basePath || '';
        // Remove any leading slash from path and trailing slash from basePath
        const cleanPath = path.replace(/^\/+/, '');
        const cleanBase = basePath.replace(/\/+$/, '');
        
        // Join with single slash
        return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
    }

    const detectOS = () => {
        const userAgent = navigator.userAgent;
        const isMac = /Macintosh|Mac OS X/i.test(userAgent);
        return isMac;
    }
    const isMacOS = detectOS();
    
    const setupToolTips = (tooltips) => {
        // Check if it's a mobile device using a media query or pointer query
        const isMobile = window.matchMedia('(max-width: 585px)').matches || window.matchMedia('(pointer: coarse)').matches;
        if (isMobile) return;
        
        // Function to hide all visible tooltips
        const hideAllTooltips = () => {
            document.querySelectorAll('.tooltip.show').forEach(tip => {
                tip.classList.remove('show');
            });
        };
        
        tooltips.forEach((element) => {
            let tooltipText = element.getAttribute('data-tooltip');
            const shortcutsStr = element.getAttribute('data-shortcuts');

            if (tooltipText && shortcutsStr) {
                try {
                    const shortcuts = JSON.parse(shortcutsStr);
                    let shortcutToUse = isMacOS ? shortcuts.mac : shortcuts.win;
    
                    if (shortcutToUse) {
                        tooltipText = tooltipText.replace(`{shortcut}`, shortcutToUse);
                        element.setAttribute('data-tooltip', tooltipText);
                    } else {
                        console.warn(`No shortcut found for ${isMacOS ? 'mac' : 'win'}`);
                    }
    
                } catch (error) {
                    console.error("Error parsing shortcuts:", error);
                }
            }

            let tooltip = document.createElement('div');
            tooltip.classList.add('tooltip');
            document.body.appendChild(tooltip);
    
            element.addEventListener('mouseover', (e) => {
                // First hide all visible tooltips
                hideAllTooltips();
                
                // Then show this tooltip
                tooltip.textContent = element.getAttribute('data-tooltip');
                tooltip.style.left = e.pageX + 10 + 'px';
                tooltip.style.top = e.pageY + 10 + 'px';
                tooltip.classList.add('show');
                
                // Stop event propagation to prevent parent tooltips from showing
                e.stopPropagation();
            });
            
            element.addEventListener('mouseout', (e) => {
                tooltip.classList.remove('show');
                
                // Prevent the mouseout event from bubbling to parent elements
                e.stopPropagation();
            });
        });
        
        // Also hide tooltips when clicking anywhere
        document.addEventListener('click', hideAllTooltips);
    }
    
    /**
     * Updates the UI version display with a specific version
     * @param {string} version - Version to display (optional)
     * @param {boolean} loading - Whether to show loading state
     */
    function updateVersionDisplay(version, loading = false) {
        const versionDisplay = document.getElementById('version-display');
        if (!versionDisplay) return;
        
        if (loading) {
            versionDisplay.textContent = 'Loading...';
            versionDisplay.classList.add('loading');
            return;
        }
        
        if (version) {
            versionDisplay.textContent = `v${version}`;
            versionDisplay.classList.remove('loading');
            return;
        }
        
        // No version provided, try to get from service worker manager or config
        if (serviceWorkerManager) {
            serviceWorkerManager.getCurrentCacheVersion()
                .then(cacheInfo => {
                    if (cacheInfo.version) {
                        versionDisplay.textContent = `v${cacheInfo.version}`;
                    } else if (window.appConfig?.version) {
                        versionDisplay.textContent = `v${window.appConfig.version}`;
                    } else {
                        versionDisplay.textContent = '';
                    }
                    versionDisplay.classList.remove('loading');
                })
                .catch(error => {
                    console.error('Error updating version display:', error);
                    // Fall back to app config version
                    if (window.appConfig?.version) {
                        versionDisplay.textContent = `v${window.appConfig.version}`;
                    } else {
                        versionDisplay.textContent = '';
                    }
                    versionDisplay.classList.remove('loading');
                });
        } else {
            // Fallback if service worker manager isn't initialized
            if (window.appConfig?.version) {
                versionDisplay.textContent = `v${window.appConfig.version}`;
            } else {
                versionDisplay.textContent = '';
            }
            versionDisplay.classList.remove('loading');
        }
    }

    /**
     * Initializes the application
     */
    async function initialize() {
        // Initialize UI components
        initThemeToggle();
        
        // Set site title
        const siteTitle = window.appConfig?.siteTitle || 'DumbTerm';
        document.getElementById('pageTitle').textContent = siteTitle;
        document.getElementById('siteTitle').textContent = siteTitle;

        // Configure UI based on app settings
        if (window.appConfig?.isDemoMode) {
            document.getElementById('demo-banner').style.display = 'block';
        }
        
        if (!window.appConfig?.isPinRequired) {
            document.getElementById("logoutBtn").style.display = 'none';
        }

        // Wait for fonts to load
        await waitForFonts();

        // Initialize terminal
        const terminalManager = new TerminalManager(isMacOS, setupToolTips);

        // Set up tooltips
        const tooltips = document.querySelectorAll('[data-tooltip]');
        setupToolTips(tooltips);
        
        // Initialize service worker manager
        serviceWorkerManager = new ServiceWorkerManager();
        serviceWorkerManager.initialize(updateVersionDisplay);
    }

    initialize().catch(console.error);
});