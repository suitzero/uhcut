from playwright.sync_api import sync_playwright

def test():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("http://localhost:8080")

        # Click the language button to switch to Korean
        lang_btn = page.locator('.lang-btn')
        lang_btn.click()

        page.wait_for_timeout(1000)

        page.screenshot(path="verification.png")
        browser.close()

test()
