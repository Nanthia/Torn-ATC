# ⚔️ Torn Conflict Manager (Torn ATC)

A real-time intelligence overlay for Torn that tracks faction overseas activity and airspace movement during conflicts.

Built as a Tampermonkey userscript that integrates directly into the Torn web interface.

## This is a work in progress. If you find a bug let me know by sending me a message in Torn (-Antheia-)
---

## 🚀 Features

### 🌍 Theatre Map Tracking
- Tracks overseas faction presence
- Groups members by country
- Displays ally vs enemy distribution
- Uses live Torn API faction data

### ✈️ Airspace Monitoring
- Detects returning flights to Torn
- Tracks outbound / transit movement
- Separates ally vs enemy movement
- Updates in real-time

### 🧠 Smart Status Parsing
- Detects:
  - Abroad locations
  - Hospital overseas locations
  - Traveling states
- Interprets Torn status text automatically

### 🪟 In-Game Overlay UI
- Draggable floating dashboard
- Resizable panel
- Two-tab system:
  - MAP
  - AIRSPACE
- Persistent position memory

---

## 🔧 Installation

### 1. Install Tampermonkey
- Chrome: https://www.tampermonkey.net/
- Firefox: https://www.tampermonkey.net/

### 2. Install Script
Click this link to install:

https://raw.githubusercontent.com/Nanthia/Torn-ATC/main/torn-conflict-manager.user.js


Tampermonkey will prompt installation automatically.

## How to Find Faction ID

- Go to the faction you are at war with
- Find the faction link in the Url
- In the Url look for the numeric number at the end of the link
- Copy the numbers and enter that into the tool

  **<img width="1261" height="208" alt="image" src="https://github.com/user-attachments/assets/e5eda16c-4eb1-43ca-a881-650a8c18120b" />
**

---

## 🔄 Auto Updates

This script supports automatic updates via GitHub.

⚠️ Disclaimer

This is an unofficial third-party tool and is not affiliated with Torn.

Use of the Torn API is subject to Torn’s API rules and rate limits.
