# Design System & UI Specifications — Pavi Dashboard

> **Status:** Canonical UI/UX Specification  
> **Aesthetic Theme:** Cyberpunk Dark Glassmorphism  
> **Target Devices:** Desktop Web Browsers, Tablets, Mobile Phones (PWA)  
> **Last Updated:** 2026-09-25

---

## 1. Visual Philosophy & Aesthetic Identity

The Pavi dashboard employs a modern **Dark Cyberpunk Glassmorphic** visual identity. The interface is engineered to evoke high-performance developer tooling: deep obsidian backgrounds, translucent frosted cards, subtle gradient borders, and glowing status indicators.

---

## 2. Color Palette & Design Tokens

### 2.1 Base & Surface Colors

| Token Name | Hex Value | Usage & Application |
|------------|-----------|---------------------|
| `--bg-primary` | `#0a0a12` | Root window background |
| `--bg-secondary` | `#12121e` | Sidebar and navigation container |
| `--glass-bg` | `rgba(255, 255, 255, 0.03)` | Frosted glass card surfaces |
| `--glass-border` | `rgba(255, 255, 255, 0.08)` | Card borders and structural dividers |
| `--glass-blur` | `blur(20px)` | Backdrop filter for depth layering |

### 2.2 Accent & Brand Gradients

| Role | Gradient / Hex | Visual Preview & Purpose |
|------|----------------|--------------------------|
| **Brand Primary** | `linear-gradient(135deg, #6366f1, #a78bfa)` | Primary action buttons (`Build`), active badges, logo icon |
| **Accent Indigo** | `#6366f1` | Focus rings, link highlights, primary interactive icons |
| **Accent Violet** | `#a78bfa` | Secondary highlights, gradient terminals |
| **Success Emerald** | `#10b981` | System online indicators, passed tests, quality score >= 80 |
| **Warning Amber** | `#f59e0b` | Reviewer warnings, retrying jobs, quality score 50–79 |
| **Danger Rose** | `#f43f5e` | Failed runs, unhandled exceptions, quality score < 50 |

### 2.3 Typography Scale & Fonts

```css
--font-heading: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
--font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
```

| Element | Font Family | Size | Weight | Line Height |
|---------|-------------|------|--------|-------------|
| **H1 Title** | Outfit | `1.8rem` (28px) | 700 (Bold) | 1.2 |
| **H2 Section** | Outfit | `1.4rem` (22px) | 600 (Semi-bold) | 1.3 |
| **Body Regular** | Inter | `0.95rem` (15px) | 400 (Regular) | 1.5 |
| **Label / Subtitle** | Inter | `0.8rem` (13px) | 500 (Medium) | 1.4 |
| **Code / Log Output** | JetBrains Mono | `0.85rem` (14px) | 400 (Regular) | 1.6 |

---

## 3. Specialized Component Specifications

### 3.1 Magic Workspace
* **Input Box:** Dark inset container (`background: rgba(0,0,0,0.2)`) with glowing border focus state (`border-color: #6366f1`).
* **Build Action Button:** High-contrast gradient button with hover elevation and active state transition.
* **Timeline Stepper:** Dynamic vertical or horizontal progress blocks displaying active steps:
  - 📝 *Drafting Plan...*
  - ⚙️ *Executing Agents...*
  - 🔍 *Reviewer Verification...*
  - ✅ *Complete / Ready for Approval*

### 3.2 Maker & Checker Engine Card
* Displays dual-bot orchestration configuration:
  - **Worker (Heavy Lifter):** Provider (Ollama), Model (`phi3:mini` / `qwen2.5-coder`), URL.
  - **Checker (Reviewer):** Strictness rating (0–100%), prompt compliance rules.
* **Quality Score Pill:** Visual badge dynamically rendered with color transitions:
  - `Green (80-100)`: Clean pass
  - `Amber (50-79)`: Pass with advisory notes
  - `Red (0-49)`: Failure / Trigger auto-retry

### 3.3 System Health Monitor (Sidebar Footer)
* Compact status indicators showing live health of backend subsystems:
  - **SQLite DB:** Green dot (`Online - WAL Mode`)
  - **Local Ollama:** Green/Red dot (`127.0.0.1:11434 reachable`)
  - **Memory:** Dynamic RAM consumption readout

---

## 4. Mobile & Touch Screen Responsive Rules

1. **Touch Target Size:** All interactive buttons, icons, and input switches must have a minimum tap area of **44px × 44px** to meet WCAG standards.
2. **Bottom Clearance:** On mobile views (`mobile.html`), content containers must include **`pb-24` (96px)** padding to prevent floating bottom navigation or action bars from covering interactive elements.
3. **No Horizontal Scroll:** All card layouts must use flexbox wrap or responsive grids (`minmax(280px, 1fr)`) preventing accidental horizontal scrolling.
4. **QR Code Pairing Modal:** Responsive modal scaled to 90% viewport width on mobile devices, displaying the pairing QR code and 1-tap copyable LAN URL.
