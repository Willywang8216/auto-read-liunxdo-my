#!/usr/bin/env python3
"""
Cookie Refresher for Linux.do Auto-Read
========================================
Uses curl_cffi to impersonate Chrome's TLS fingerprint and log in to linux.do
to get fresh _t cookies for all accounts.

Usage:
    python3 refresh_cookies.py

Output:
    Prints the updated COOKIES env var value for GitHub Actions secrets.
"""

import json
import sys
import time
from curl_cffi import requests

# Account credentials
ACCOUNTS = [
    {"username": "goodhaohao", "password": "dsfgr$÷@DH532"},
    {"username": "supercool", "password": "dsfgr$÷@DH532"},
    {"username": "superwill", "password": "dsfgr$÷@DH532"},
]

BASE_URL = "https://linux.do"


def login_account(account):
    """Log in to linux.do and return the _t cookie value."""
    username = account["username"]
    password = account["password"]

    print(f"\n[{username}] Starting login...")

    # Create a session with Chrome impersonation
    session = requests.Session(impersonate="chrome110")

    # Step 1: Visit main page to get initial cookies and solve Cloudflare challenge
    print(f"  Getting main page...")
    r = session.get(BASE_URL, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })

    if r.status_code == 403:
        print(f"  Cloudflare challenge detected, trying to solve...")
        # The challenge page might have a redirect or JS challenge
        # Try accessing a known-working endpoint first to establish session
        r2 = session.get(f"{BASE_URL}/latest.json", headers={"Accept": "application/json"})
        print(f"  Latest.json: {r2.status_code}")

        # Try the main page again
        r = session.get(BASE_URL, headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        print(f"  Main page retry: {r.status_code}")

    # Step 2: Get CSRF token
    print(f"  Getting CSRF token...")
    r = session.get(f"{BASE_URL}/session/csrf.json", headers={
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
    })

    if r.status_code != 200:
        print(f"  ✗ CSRF failed: {r.status_code}")
        return None

    csrf_data = json.loads(r.text)
    csrf = csrf_data.get("csrf", "")

    if not csrf:
        print(f"  ✗ No CSRF token in response")
        return None

    print(f"  Got CSRF token")

    # Step 3: Login
    print(f"  Logging in...")
    r = session.post(f"{BASE_URL}/session",
        data={"login": username, "password": password},
        headers={
            "X-CSRF-Token": csrf,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json",
            "Referer": f"{BASE_URL}/",
            "Origin": BASE_URL,
        }
    )

    print(f"  Login response: {r.status_code}")

    if r.status_code not in [200, 302]:
        print(f"  ✗ Login failed: {r.text[:200]}")
        return None

    # Step 4: Extract _t cookie
    cookies = session.cookies.get_dict()
    t_cookie = cookies.get("_t")

    if t_cookie:
        print(f"  ✓ Got _t cookie: {t_cookie[:50]}...")
        return t_cookie
    else:
        print(f"  ✗ No _t cookie found. Cookies: {list(cookies.keys())}")
        # Try to get it from response headers
        for header in r.headers.get("set-cookie", "").split(","):
            if "_t=" in header:
                t_cookie = header.split("_t=")[1].split(";")[0]
                print(f"  ✓ Got _t from headers: {t_cookie[:50]}...")
                return t_cookie
        return None


def main():
    print("=" * 60)
    print("Linux.do Cookie Refresher")
    print("=" * 60)

    cookies = []
    success_count = 0

    for account in ACCOUNTS:
        t_cookie = login_account(account)
        if t_cookie:
            cookies.append(t_cookie)
            success_count += 1
        else:
            cookies.append("")  # placeholder
        time.sleep(3)  # Delay between accounts

    print(f"\n{'=' * 60}")
    print(f"Results: {success_count}/{len(ACCOUNTS)} accounts refreshed")

    if success_count > 0:
        # Build the COOKIES env var
        cookies_str = ",".join(cookies)
        usernames_str = ",".join(a["username"] for a in ACCOUNTS)

        print(f"\nUpdate these GitHub Secrets:")
        print(f"\nUSERNAMES:")
        print(f"  {usernames_str}")
        print(f"\nCOOKIES:")
        print(f"  {cookies_str}")

        # Also write to a file
        with open("refreshed_cookies.txt", "w") as f:
            f.write(f"USERNAMES={usernames_str}\n")
            f.write(f"COOKIES={cookies_str}\n")
        print(f"\nAlso saved to refreshed_cookies.txt")
    else:
        print("\nNo cookies refreshed. Cloudflare may be blocking all requests.")
        print("Try again later or run from a different IP/network.")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
