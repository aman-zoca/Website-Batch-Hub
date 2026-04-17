// Configuration file for Website Popup Tester
// Customize selectors and test data for different websites

export const siteConfigs = {
  // Default configuration for mononest.dev sites
  "mononest.dev": {
    selectors: {
      navbarCTA: "#cta-button-desktop",
      heroCTA: "#hero-cta-button",
      bookingModal: "#booking-modal",
      modalClose: "#booking-modal-close",
      firstNameInput:
        '#cta-firstName-input, input[data-form-field="ctaFormFirstName"]',
      lastNameInput: "#cta-lastName-input",
      phoneInput: "#modal-phone-number-input",
      submitButton: "#book-now-button",
    },
    testData: {
      firstName: "Test",
      lastName: "iAmBot",
      phone: "12343831494",
    },
  },

  // Add more site-specific configurations here
  // Example:
  // 'example.com': {
  //   selectors: {
  //     navbarCTA: '.nav-cta-button',
  //     heroCTA: '.hero-cta',
  //     bookingModal: '.modal',
  //     modalClose: '.modal-close',
  //     firstNameInput: 'input[name="first_name"]',
  //     lastNameInput: 'input[name="last_name"]',
  //     phoneInput: 'input[name="phone"]',
  //     submitButton: 'button[type="submit"]'
  //   },
  //   testData: {
  //     firstName: 'Test',
  //     lastName: 'User',
  //     phone: '1234567890'
  //   }
  // }
};

// Global test settings
export const globalConfig = {
  headless: false, // Set to true for background testing
  slowMo: 100, // Milliseconds to slow down actions (0 for fast)
  timeout: 30000, // Global timeout in milliseconds
  screenshotOnError: true, // Take screenshot when step fails
  retryFailedSteps: false, // Retry failed steps once
  maxRetries: 1, // Number of retries for failed steps
};

// Get configuration for a specific URL
export function getConfigForUrl(url) {
  const hostname = new URL(url).hostname;

  // Check for exact match first
  if (siteConfigs[hostname]) {
    return siteConfigs[hostname];
  }

  // Check for partial match (e.g., 'mononest.dev' matches 'priyamakeoverla4.mononest.dev')
  for (const [domain, config] of Object.entries(siteConfigs)) {
    if (hostname.includes(domain)) {
      return config;
    }
  }

  // Return default mononest config as fallback
  return siteConfigs["mononest.dev"];
}
