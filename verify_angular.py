from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            # Navigate to the served Angular app
            page.goto("http://localhost:8080")

            # Wait for the app-root to be present
            page.wait_for_selector("app-root")

            # Check title
            title = page.title()
            print(f"Page title: {title}")

            # Take a screenshot
            page.screenshot(path="verification.png")
            print("Screenshot saved to verification.png")

        except Exception as e:
            print(f"Error: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    run()
