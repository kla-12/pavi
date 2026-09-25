# 📱 Ruflo / Pavi — Mobile Setup & Deployment Guide

Is guide me aapko **Phone par chalane** aur **Online Deploy karne** ke saare aasan tareeqe milenge.

---

## 🚀 1. Phone Par Chalana (Same Wi-Fi Par — Sabse Tez & Asaan)

Aapka Ruflo Dashboard already mobile-ready hai aur isme dedicated Mobile PWA interface shamil hai!

### Steps:
1. **Laptop par server start karein:**
   - `ruflo-main/ruflo-main/` folder me jakar **`mobile_launch.bat`** (ya `launch.bat`) par double click karein.
2. **Phone ko same Wi-Fi se connect karein:**
   - Aapka laptop aur phone dono ek hi Wi-Fi router / mobile hotspot se connected hone chahiye.
3. **Phone ke browser me link open karein:**
   - Chrome ya Safari browser open karein aur URL dalein:
     ```text
     http://192.168.31.66:3000/mobile
     ```
     *(Note: Agar aapka Wi-Fi badal jaye to `mobile_launch.bat` aapko nayi IP dikha dega)*
4. **Login PIN:**
   - Default PIN: `123456`
5. **App ki tarah Install karein (PWA):**
   - Chrome me: 3-dots menu par tap karein ➔ **"Add to Home Screen"** ya **"Install App"**.
   - Safari (iPhone) me: Share button par tap karein ➔ **"Add to Home Screen"**.
   - Ab ye aapke phone par ek real mobile app ki tarah open hoga!

---

## 🌐 2. Phone Par Kahin Se Bhi Chalana (Mobile Data / 4G / 5G / Bahar Se)

Agar aap ghar se bahar hain ya phone mobile data par hai, to aap ek free HTTPS public tunnel use kar sakte hain:

### Steps:
1. Pehle `mobile_launch.bat` chalayein taaki server port 3000 par start ho jaye.
2. Uske baad **`public_tunnel.bat`** par double click karein.
3. Terminal me aapko ek secure HTTPS link milegi jaise:
   ```text
   https://xxxx-xxxx.loca.lt
   ```
4. Phone ke browser me open karein:
   ```text
   https://xxxx-xxxx.loca.lt/mobile
   ```
   *(Pehli baar open karne par agar localtunnel warning aaye to aapke laptop ka public IP maang sakta hai, simply confirm karein).*

---

## ☁️ 3. Online Cloud Par Deploy Karna (24/7 Running)

Agar aap chahte hain ki laptop band hone par bhi ye 24/7 internet par chalta rahe:

### Option A: Render.com ya Railway.app (Free / Cheap)
1. **GitHub par code push karein:**
   - Apne repository ko GitHub par private ya public repo me push karein.
2. **Render / Railway me New Web Service banayein:**
   - **Root Directory:** `ruflo-main/dashboard` (ya repository ka `dashboard` folder)
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
3. **Environment Variables set karein:**
   - `PORT`: `3000`
   - `JWT_SECRET`: `koi_bhi_strong_secret_key`
   - `MOBILE_PIN`: `123456` (ya jo PIN aap chahein)
   - `SKIP_AUTH_ON_LOCALHOST`: `false`
   - *(Note: Cloud par local Ollama nahi chalta, isliye Settings me Groq, OpenAI, Gemini ya Claude ki API key daal kar AI use kar sakte hain).*

### Option B: VPS (DigitalOcean, Hetzner, AWS EC2, Oracle Cloud)
1. Ubuntu VPS par Node.js 20 aur Ollama install karein:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   curl -fsSL https://ollama.com/install.sh | sh
   ```
2. Repo clone karein aur dashboard folder me jayein:
   ```bash
   cd ruflo-main/dashboard
   npm install
   ```
3. Background me chalane ke liye PM2 use karein:
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name "ruflo-dashboard"
   pm2 startup && pm2 save
   ```
4. Ab apne VPS ke Public IP se access karein:
   ```text
   http://YOUR_SERVER_IP:3000/mobile
   ```
