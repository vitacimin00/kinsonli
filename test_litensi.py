#!/usr/bin/env python3
"""Test Litensi API directly from server — bypass our proxy to debug."""
import urllib.request
import urllib.parse
import json
import time
import ssl

API_BASE = "https://litensi.id/api"
API_ID = 2445
API_KEY = "b2RtrK8pYQOdk2DqrH2yM7UyMLYP7oyV"

def call_api(endpoint, params=None):
    """Test API call with detailed logging."""
    url = f"{API_BASE}/{endpoint}"
    post_data = {"api_id": API_ID, "api_key": API_KEY}
    if params:
        post_data.update(params)

    encoded = urllib.parse.urlencode(post_data).encode("utf-8")

    print(f"\n{'='*60}")
    print(f"POST {url}")
    print(f"Content-Type: application/x-www-form-urlencoded")
    print(f"Body: {encoded.decode()}")
    print(f"{'='*60}")

    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(
            url,
            data=encoded,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "application/json, text/plain, */*",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            raw = resp.read().decode()
            print(f"Status: {resp.status}")
            print(f"Response: {raw}")
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        print(f"HTTP Error: {e.code}")
        print(f"Response: {raw}")
        return json.loads(raw) if raw else {"error": e.code}
    except Exception as e:
        print(f"Exception: {e}")
        return {"error": str(e)}

# Test 1: Profile
print("\n🔑 TEST 1: Profile")
result = call_api("profile")
print(f"Result: {json.dumps(result, indent=2)}")

# Test 2: Prices
print("\n💰 TEST 2: Prices for x.ai")
result = call_api("mail/prices", {"site": "x.ai"})
if result.get("success"):
    # Show only hotmail/outlook
    zones = [z for z in result["data"] if z["zone"] in ("hotmail.com", "outlook.com")]
    print(f"Filtered zones: {json.dumps(zones, indent=2)}")

# Test 3: Order
print("\n📧 TEST 3: Order hotmail.com for x.ai")
result = call_api("mail/order", {"zone": "hotmail.com", "site": "x.ai"})
print(f"Result: {json.dumps(result, indent=2)}")

if result.get("success"):
    order_id = result["data"]["order_id"]
    email = result["data"]["email"]
    print(f"\n✅ Order success! ID={order_id}, Email={email}")

    # Test 4: Quick second order (to reproduce the error)
    print("\n📧 TEST 4: Second order IMMEDIATELY (to test rate limit)")
    result2 = call_api("mail/order", {"zone": "hotmail.com", "site": "x.ai"})
    print(f"Result: {json.dumps(result2, indent=2)}")

    # Test 5: Wait 5 seconds then try again
    print("\n⏳ Waiting 5 seconds...")
    time.sleep(5)
    print("\n📧 TEST 5: Third order after 5s delay")
    result3 = call_api("mail/order", {"zone": "hotmail.com", "site": "x.ai"})
    print(f"Result: {json.dumps(result3, indent=2)}")

    # Cancel all test orders
    print("\n🗑 Canceling test orders...")
    call_api("mail/setstatus", {"order_id": order_id, "status": "CANCELED"})
    if result2.get("success"):
        call_api("mail/setstatus", {"order_id": result2["data"]["order_id"], "status": "CANCELED"})
    if result3.get("success"):
        call_api("mail/setstatus", {"order_id": result3["data"]["order_id"], "status": "CANCELED"})
else:
    print(f"\n❌ First order failed: {result}")
    # Try with JSON content-type instead
    print("\n🔄 TEST 3b: Retry with JSON content-type")
    url = f"{API_BASE}/mail/order"
    post_data = {"api_id": API_ID, "api_key": API_KEY, "zone": "hotmail.com", "site": "x.ai"}
    encoded_json = json.dumps(post_data).encode("utf-8")
    try:
        req = urllib.request.Request(
            url,
            data=encoded_json,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode()
            print(f"JSON Result: {raw}")
            # Cancel if success
            r = json.loads(raw)
            if r.get("success"):
                call_api("mail/setstatus", {"order_id": r["data"]["order_id"], "status": "CANCELED"})
    except Exception as e:
        print(f"JSON also failed: {e}")

print("\n✅ Done!")
