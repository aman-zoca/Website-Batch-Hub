import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());

// Serve dashboard HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Configuration
const CONFIG = {
  headless: false,
  slowMo: 20,
  timeout: 15000,
  stepDelay: 500, // ms to wait after each step (adjust this to speed up/slow down)
  defaultTestData: {
    firstName: "Test",
    lastName: "iAmBot",
    phone: "2343831494",
  },
};

const DEFAULT_SELECTORS = {
  navbarCTA: '[data-event-onclick^="handleGetInTouch"]',
  heroCTA: '[data-event-onclick^="handleGetInTouch"]',
  bookingModal: "#booking-modal",
  modalClose: "#booking-modal-close",
  firstNameInput: "#cta-firstName-input",
  lastNameInput: "#cta-lastName-input",
  phoneInput: "#modal-phone-number-input",
  submitButton: "#book-now-button",
};

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: CONFIG.headless,
      slowMo: CONFIG.slowMo,
      args: ["--start-maximized", "--no-sandbox"],
    });
  }
  return browser;
}

async function runTest(
  url,
  selectors = DEFAULT_SELECTORS,
  testData = CONFIG.defaultTestData,
  enabledSteps = null,
) {
  const result = {
    url,
    timestamp: new Date().toISOString(),
    steps: [],
    overall: "PENDING",
    success: false,
  };

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Step key mapping for enable/disable
  const STEP_KEYS = {
    "Navigate to website": "navigate",
    "Click navbar Book Appointment": "navbar_click",
    "Verify booking modal opens (navbar)": "navbar_modal",
    "Close booking modal": "close_modal",
    "Click hero Get In Touch": "hero_click",
    "Verify booking modal opens (hero)": "hero_modal",
    "Fill first name": "fill_firstname",
    "Fill last name": "fill_lastname",
    "Fill phone number": "fill_phone",
    "Submit form": "submit",
    "Navigate to services page": "svc_page",
    "Click Add Service button 1": "add_svc1",
    "Verify booking cart appears": "svc_cart",
    "Remove service from cart": "remove_svc",
    "Click Add Service button 2": "add_svc2",
    "Click category tab 1": "cat_tab1",
    "Click category tab 2": "cat_tab2",
    "Test search services": "search",
  };

  const step = async (name, action) => {
    // Check if this step is disabled
    const stepKey = STEP_KEYS[name];
    if (enabledSteps && stepKey && !enabledSteps.includes(stepKey)) {
      const skipResult = { name, status: "SKIPPED", startTime: new Date().toISOString(), endTime: new Date().toISOString() };
      result.steps.push(skipResult);
      console.log(`  [SKIPPED] ${name}`);
      return skipResult;
    }

    const stepResult = {
      name,
      status: "PENDING",
      startTime: new Date().toISOString(),
    };

    try {
      console.log(`  [RUNNING] ${name}...`);
      await action();
      stepResult.status = "SUCCESS";
      stepResult.endTime = new Date().toISOString();
      console.log(`  [SUCCESS] ${name}`);
      // Wait between steps for monitoring
      if (CONFIG.stepDelay > 0) {
        await new Promise(r => setTimeout(r, CONFIG.stepDelay));
      }
    } catch (error) {
      stepResult.status = "FAILED";
      stepResult.error = error.message;
      stepResult.endTime = new Date().toISOString();
      console.log(`  [FAILED] ${name}: ${error.message}`);
    }

    result.steps.push(stepResult);
    return stepResult;
  };

  try {
    console.log(`\nTesting: ${url}`);

    // Step 1: Navigate
    await step("Navigate to website", async () => {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.timeout,
      });

      // Check for 404 or other errors
      const status = response?.status();
      if (status === 404 || status >= 400) {
        throw new Error(`Page returned ${status}`);
      }

      // Check for 404 content
      const is404 = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || '';
        return text.includes('404') && text.includes('not found');
      });
      if (is404) {
        throw new Error('Page shows 404 not found');
      }

      // Initial wait for page to fully load
      await new Promise(resolve => setTimeout(resolve, 2000));
    });

    // Step 2: Click navbar CTA
    await step("Click navbar Book Appointment", async () => {
      // Find and click element with data-event-onclick starting with handleGetInTouch
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('[data-event-onclick^="handleGetInTouch"]');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        throw new Error('Could not find handleGetInTouch button');
      }

      // Small wait for modal animation
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    // Step 3: Verify navbar modal
    await step("Verify booking modal opens (navbar)", async () => {
      await page.waitForSelector(selectors.bookingModal, {
        visible: true,
        timeout: 2000,
      });
      const modalDisplay = await page.$eval(selectors.bookingModal, (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!modalDisplay) throw new Error("Modal not visible");
    });

    // Step 4: Close modal
    await step("Close booking modal", async () => {
      await page.waitForSelector(selectors.modalClose, {
        visible: true,
        timeout: 2000,
      });
      await page.click(selectors.modalClose);
      await page.waitForFunction(
        (selector) => {
          const modal = document.querySelector(selector);
          if (!modal) return true;
          const style = window.getComputedStyle(modal);
          return style.display === "none" || style.opacity === "0";
        },
        { timeout: 2000 },
        selectors.bookingModal,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // Step 5: Click hero CTA
    await step("Click hero Get In Touch", async () => {
      // Find all handleGetInTouch buttons and click the second one (hero)
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('[data-event-onclick^="handleGetInTouch"]');
        // Click second button if exists (hero), otherwise first
        const btn = buttons[1] || buttons[0];
        if (btn) {
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        throw new Error('Could not find handleGetInTouch button');
      }
    });

    // Step 6: Verify hero modal
    await step("Verify booking modal opens (hero)", async () => {
      await page.waitForSelector(selectors.bookingModal, {
        visible: true,
        timeout: 2000,
      });
      const modalDisplay = await page.$eval(selectors.bookingModal, (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!modalDisplay) throw new Error("Modal not visible");
    });

    // Step 7: Fill first name (skip if prefilled)
    await step("Fill first name", async () => {
      const firstNameSelector = selectors.firstNameInput;
      const altSelector = 'input[data-form-field="ctaFormFirstName"]';

      let selector = firstNameSelector;
      try {
        await page.waitForSelector(firstNameSelector, { visible: true, timeout: 2000 });
      } catch (e) {
        await page.waitForSelector(altSelector, { visible: true, timeout: 2000 });
        selector = altSelector;
      }

      const existingValue = await page.$eval(selector, el => el.value);
      if (existingValue && existingValue.trim() !== '') {
        console.log(`    [SKIP] First name already prefilled: "${existingValue}"`);
        return;
      }
      await page.type(selector, testData.firstName, { delay: 10 });
    });

    // Step 8: Fill last name (skip if prefilled)
    await step("Fill last name", async () => {
      await page.waitForSelector(selectors.lastNameInput, {
        visible: true,
        timeout: 2000,
      });

      const existingValue = await page.$eval(selectors.lastNameInput, el => el.value);
      if (existingValue && existingValue.trim() !== '') {
        console.log(`    [SKIP] Last name already prefilled: "${existingValue}"`);
        return;
      }
      await page.type(selectors.lastNameInput, testData.lastName, { delay: 10 });
    });

    // Step 9: Fill phone (skip if prefilled)
    await step("Fill phone number", async () => {
      await page.waitForSelector(selectors.phoneInput, {
        visible: true,
        timeout: 2000,
      });

      const existingValue = await page.$eval(selectors.phoneInput, el => el.value);
      if (existingValue && existingValue.trim() !== '') {
        console.log(`    [SKIP] Phone already prefilled: "${existingValue}"`);
        return;
      }
      await page.type(selectors.phoneInput, testData.phone, { delay: 10 });
    });

    // Step 10: Submit
    await step("Submit form", async () => {
      await page.waitForSelector(selectors.submitButton, {
        visible: true,
        timeout: 2000,
      });
      await page.click(selectors.submitButton);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    // === SERVICE PAGE TESTS ===

    // Step 11: Navigate to /services page
    await step("Navigate to services page", async () => {
      // Close modal first if open
      try {
        const modalVisible = await page.evaluate(() => {
          const modal = document.querySelector('#booking-modal');
          if (modal) {
            const style = window.getComputedStyle(modal);
            return style.display !== 'none' && style.opacity !== '0';
          }
          return false;
        });
        if (modalVisible) {
          await page.click('#booking-modal-close');
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (e) { /* ignore */ }

      // Look for "View All Services" link and click it
      const clicked = await page.evaluate(() => {
        const link = document.querySelector('[data-variable-href="ViewAllServicesUrl"]') ||
                     document.querySelector('a[href="/services"]') ||
                     document.querySelector('.view-all-button');
        if (link) {
          link.scrollIntoView({ behavior: 'instant', block: 'center' });
          link.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        // Fallback: navigate directly to /services
        const serviceUrl = new URL('/services', url).href;
        await page.goto(serviceUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      }

      // Wait for services page to load
      await new Promise(r => setTimeout(r, 3000));

      // Verify we're on services page
      const onServicesPage = await page.evaluate(() => {
        return window.location.pathname.includes('/services') ||
               !!document.querySelector('.category-tabs') ||
               !!document.querySelector('[data-event-onclick^="handleCardAction"]');
      });
      if (!onServicesPage) throw new Error('Not on services page');
    });

    // Helper: handle variations modal if it appears after clicking Add Service
    async function handleVariationsModal() {
      await new Promise(r => setTimeout(r, 1000));

      const hasVariationsModal = await page.evaluate(() => {
        const modal = document.querySelector('#service-variations-modal');
        if (!modal) return false;
        const style = window.getComputedStyle(modal);
        return style.display !== 'none';
      });

      if (hasVariationsModal) {
        console.log('    [INFO] Variations modal detected — selecting first variation');

        // Click the first variation option
        await page.evaluate(() => {
          const firstVariation = document.querySelector('.variation-option');
          if (firstVariation) firstVariation.click();
        });
        await new Promise(r => setTimeout(r, 500));

        // Click SELECT button
        const selected = await page.evaluate(() => {
          const selectBtn = document.querySelector('#variations-select-btn');
          if (selectBtn && !selectBtn.disabled) {
            selectBtn.click();
            return true;
          }
          return false;
        });

        if (!selected) {
          // SELECT might still be disabled — click variation again to be sure
          await page.evaluate(() => {
            const variation = document.querySelector('.variation-option');
            if (variation) variation.click();
          });
          await new Promise(r => setTimeout(r, 500));
          await page.evaluate(() => {
            const selectBtn = document.querySelector('#variations-select-btn');
            if (selectBtn) selectBtn.click();
          });
        }

        await new Promise(r => setTimeout(r, 1000));

        // If modal is still open, close it with the X button
        const stillOpen = await page.evaluate(() => {
          const modal = document.querySelector('#service-variations-modal');
          if (!modal) return false;
          return window.getComputedStyle(modal).display !== 'none';
        });
        if (stillOpen) {
          await page.evaluate(() => {
            const closeBtn = document.querySelector('.variations-modal-close');
            if (closeBtn) closeBtn.click();
          });
          await new Promise(r => setTimeout(r, 500));
        }

        return true; // had variations
      }
      return false; // no variations
    }

    // Step 12: Click first "Add Service" button — verify it toggles to "Remove" (active class)
    await step("Click Add Service button 1", async () => {
      await page.waitForSelector('[data-event-onclick^="handleCardAction"]', {
        visible: true,
        timeout: 5000,
      });

      // First check if any button is already active (has "Remove" state) — if so, click to reset it
      await page.evaluate(() => {
        const activeBtn = document.querySelector('[data-event-onclick^="handleCardAction"].active');
        if (activeBtn) activeBtn.click();
      });
      await new Promise(r => setTimeout(r, 500));

      // Now click the first Add Service button
      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('[data-event-onclick^="handleCardAction"]');
        if (btns.length > 0) {
          btns[0].scrollIntoView({ behavior: 'instant', block: 'center' });
          btns[0].click();
          return true;
        }
        return false;
      });
      if (!clicked) throw new Error('No Add Service button found');

      // Handle variations modal if it pops up
      await handleVariationsModal();
      await new Promise(r => setTimeout(r, 500));

      // Verify the button now has "active" class (text changed to "Remove")
      const isActive = await page.evaluate(() => {
        const btns = document.querySelectorAll('[data-event-onclick^="handleCardAction"]');
        if (btns.length > 0) {
          return btns[0].classList.contains('active') ||
                 btns[0].textContent.trim().toLowerCase() === 'remove';
        }
        return false;
      });
      if (!isActive) throw new Error('Button did not toggle to Remove/active state');
    });

    // Step 13: Verify booking cart appears at bottom with service info
    await step("Verify booking cart appears", async () => {
      const cartVisible = await page.evaluate(() => {
        const cart = document.querySelector('#booking-cart-container') ||
                     document.querySelector('.booking-cart-container');
        if (!cart) return false;
        return cart.classList.contains('active');
      });
      if (!cartVisible) throw new Error('Booking cart not visible (no active class)');

      // Verify cart has service name text
      const serviceName = await page.evaluate(() => {
        const name = document.querySelector('#booking-cart-service-name') ||
                     document.querySelector('.booking-cart-service-name');
        return name ? name.textContent.trim() : '';
      });
      if (!serviceName) throw new Error('Cart has no service name');
      console.log(`    [INFO] Cart shows: ${serviceName}`);
    });

    // Step 14: Click the same button again (now "Remove") to remove service, verify cart disappears
    await step("Remove service from cart", async () => {
      // Click the first button again — it should be in "Remove" / active state
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('[data-event-onclick^="handleCardAction"].active') ||
                    document.querySelectorAll('[data-event-onclick^="handleCardAction"]')[0];
        if (btn) {
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          btn.click();
          return true;
        }
        return false;
      });
      if (!clicked) throw new Error('Could not find Remove button to click');
      await new Promise(r => setTimeout(r, 1000));

      // Verify button toggled back to "Add Service" (no active class)
      const toggledBack = await page.evaluate(() => {
        const btns = document.querySelectorAll('[data-event-onclick^="handleCardAction"]');
        if (btns.length > 0) {
          return !btns[0].classList.contains('active') ||
                 btns[0].textContent.trim().toLowerCase().includes('add');
        }
        return false;
      });
      if (!toggledBack) throw new Error('Button did not toggle back to Add Service');

      // Verify cart is gone
      const cartGone = await page.evaluate(() => {
        const cart = document.querySelector('#booking-cart-container') ||
                     document.querySelector('.booking-cart-container');
        if (!cart) return true;
        return !cart.classList.contains('active');
      });
      if (!cartGone) throw new Error('Cart still visible after removing service');
    });

    // Step 15: Click second "Add Service" button, verify cart comes back
    await step("Click Add Service button 2", async () => {
      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('[data-event-onclick^="handleCardAction"]');
        if (btns.length > 1) {
          btns[1].scrollIntoView({ behavior: 'instant', block: 'center' });
          btns[1].click();
          return true;
        } else if (btns.length === 1) {
          btns[0].scrollIntoView({ behavior: 'instant', block: 'center' });
          btns[0].click();
          return true;
        }
        return false;
      });
      if (!clicked) throw new Error('No Add Service button found');

      // Handle variations modal if it pops up
      await handleVariationsModal();
      await new Promise(r => setTimeout(r, 500));

      // Verify cart appeared again
      const cartVisible = await page.evaluate(() => {
        const cart = document.querySelector('#booking-cart-container') ||
                     document.querySelector('.booking-cart-container');
        return cart && cart.classList.contains('active');
      });
      if (!cartVisible) throw new Error('Cart did not appear after adding second service');

      // Now clear using "Clear All" button in cart
      const cleared = await page.evaluate(() => {
        const clearBtn = document.querySelector('#booking-cart-clear-all-button') ||
                         document.querySelector('.booking-cart-clear-all-button');
        if (clearBtn) {
          clearBtn.click();
          return true;
        }
        return false;
      });
      if (!cleared) throw new Error('Clear All button not found in cart');
      await new Promise(r => setTimeout(r, 1000));
    });

    // Step 16: Click first category tab — verify page scrolls
    await step("Click category tab 1", async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 300));

      // Record scroll position before click
      const scrollBefore = await page.evaluate(() => window.scrollY);

      const tabInfo = await page.evaluate(() => {
        const tabs = document.querySelectorAll('[data-event-onclick^="handleCategoryClick"]');
        if (tabs.length > 0) {
          tabs[0].scrollIntoView({ behavior: 'instant', block: 'center' });
          tabs[0].click();
          return { clicked: true, text: tabs[0].textContent.trim() };
        }
        return { clicked: false };
      });
      if (!tabInfo.clicked) throw new Error('No category tabs found');
      await new Promise(r => setTimeout(r, 1500));

      // Check: either tab is active OR page scrolled
      const scrollAfter = await page.evaluate(() => window.scrollY);
      const isActive = await page.evaluate(() => {
        const tabs = document.querySelectorAll('[data-event-onclick^="handleCategoryClick"]');
        return tabs.length > 0 && (tabs[0].classList.contains('active') || tabs[0].classList.contains('btn-tab-active'));
      });
      const scrolled = Math.abs(scrollAfter - scrollBefore) > 20;

      if (!isActive && !scrolled) throw new Error('Tab 1: not active and page did not scroll');
      console.log(`    [INFO] Tab 1 "${tabInfo.text}" — active: ${isActive}, scrolled: ${scrolled} (${scrollBefore} → ${scrollAfter})`);
    });

    // Step 17: Click second category tab — verify page scrolls
    await step("Click category tab 2", async () => {
      // Record scroll position before click
      const scrollBefore = await page.evaluate(() => window.scrollY);

      const tabInfo = await page.evaluate(() => {
        const tabs = document.querySelectorAll('[data-event-onclick^="handleCategoryClick"]');
        if (tabs.length > 1) {
          tabs[1].scrollIntoView({ behavior: 'instant', block: 'center' });
          tabs[1].click();
          return { clicked: true, text: tabs[1].textContent.trim() };
        }
        return { clicked: false };
      });
      if (!tabInfo.clicked) throw new Error('Second category tab not found');
      await new Promise(r => setTimeout(r, 1500));

      const scrollAfter = await page.evaluate(() => window.scrollY);
      const tabState = await page.evaluate(() => {
        const tabs = document.querySelectorAll('[data-event-onclick^="handleCategoryClick"]');
        if (tabs.length > 1) {
          return {
            tab2Active: tabs[1].classList.contains('active') || tabs[1].classList.contains('btn-tab-active'),
          };
        }
        return null;
      });
      const scrolled = Math.abs(scrollAfter - scrollBefore) > 20;

      if (!tabState?.tab2Active && !scrolled) throw new Error('Tab 2: not active and page did not scroll');
      console.log(`    [INFO] Tab 2 "${tabInfo.text}" — active: ${tabState?.tab2Active}, scrolled: ${scrolled} (${scrollBefore} → ${scrollAfter})`);
    });

    // Step 18: Test search — type, verify clear button appears, then clear
    await step("Test search services", async () => {
      // Scroll to top to find search
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 500));

      const searchSelector = '#service-search-input';
      await page.waitForSelector(searchSelector, { visible: true, timeout: 3000 });

      await page.evaluate(() => {
        const input = document.querySelector('#service-search-input');
        if (input) input.scrollIntoView({ behavior: 'instant', block: 'center' });
      });

      // Click and type in search
      await page.click(searchSelector);
      await new Promise(r => setTimeout(r, 300));
      await page.type(searchSelector, 'braid', { delay: 50 });
      await new Promise(r => setTimeout(r, 1500));

      // Verify the search clear button appeared (visible with display flex)
      const clearVisible = await page.evaluate(() => {
        const clearBtn = document.querySelector('#search-clear-button') ||
                         document.querySelector('.search-clear-button');
        if (!clearBtn) return false;
        const style = window.getComputedStyle(clearBtn);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (!clearVisible) throw new Error('Search clear button did not appear after typing');

      // Click clear button to reset search
      await page.evaluate(() => {
        const clearBtn = document.querySelector('#search-clear-button') ||
                         document.querySelector('.search-clear-button');
        if (clearBtn) clearBtn.click();
      });
      await new Promise(r => setTimeout(r, 500));

      // Verify search input is cleared
      const inputCleared = await page.evaluate(() => {
        const input = document.querySelector('#service-search-input');
        return input && input.value === '';
      });
      if (!inputCleared) throw new Error('Search input was not cleared after clicking clear button');
    });

    const failedSteps = result.steps.filter((s) => s.status === "FAILED");
    result.overall = failedSteps.length === 0 ? "SUCCESS" : "PARTIAL_FAILURE";
    result.success = true;
  } catch (error) {
    result.overall = "FAILED";
    result.error = error.message;
    result.success = false;
  } finally {
    await page.close();
  }

  return result;
}

// API endpoint
app.post("/api/test", async (req, res) => {
  const { url, stepDelay, enabledSteps } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  // Update stepDelay if provided
  if (stepDelay !== undefined) {
    CONFIG.stepDelay = Number(stepDelay);
  }

  try {
    const result = await runTest(url, DEFAULT_SELECTORS, CONFIG.defaultTestData, enabledSteps || null);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Batch API endpoint - run multiple tests in parallel
app.post("/api/test-batch", async (req, res) => {
  const { urls, stepDelay, enabledSteps } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ success: false, error: "urls array is required" });
  }

  if (stepDelay !== undefined) {
    CONFIG.stepDelay = Number(stepDelay);
  }

  try {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          return await runTest(url, DEFAULT_SELECTORS, CONFIG.defaultTestData, enabledSteps || null);
        } catch (error) {
          return { url, overall: "FAILED", error: error.message, steps: [], success: false };
        }
      })
    );
    res.json({ results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate website endpoint
app.post("/api/generate", async (req, res) => {
  const { entityId, token } = req.body;

  if (!entityId || !token) {
    return res.status(400).json({ success: false, error: "entityId and token are required" });
  }

  try {
    console.log(`\nGenerating website for entity: ${entityId}`);
    const response = await fetch(
      "https://internal.zoca.ai/internal/api/v1/website/creation/generate/website/v2",
      {
        method: "POST",
        headers: {
          "accept": "*/*",
          "content-type": "application/json",
          "authorization": `Bearer ${token}`,
          "ngrok-skip-browser-warning": "true",
          "x-ops-request": "true",
        },
        body: JSON.stringify({
          entityId,
          homeSectionsToUpdate: [],
          shouldGenerateStaticBuild: true,
          showLoadingScreen: false,
        }),
      }
    );

    const status = response.status;
    let data;
    try {
      data = await response.json();
    } catch (e) {
      data = await response.text();
    }

    console.log(`  Generate response: ${status}`, data);

    if (status >= 200 && status < 300) {
      res.json({ success: true, data });
    } else {
      res.json({ success: false, error: `HTTP ${status}: ${JSON.stringify(data)}` });
    }
  } catch (error) {
    console.log(`  Generate error: ${error.message}`);
    res.json({ success: false, error: error.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
