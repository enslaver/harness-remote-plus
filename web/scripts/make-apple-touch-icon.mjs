#!/usr/bin/env node
// Regenerates web/public/apple-touch-icon.png (180x180) from web/public/icon-512.png.
//
// Why it is a script and not just a resized copy: iOS paints any transparent pixel of a home-screen
// icon BLACK and applies its own rounded mask. The shipped artwork is already opaque (a white square,
// the same white the Android icons are generated with), but flattening it onto white here means a future
// edit that introduces transparency cannot silently turn the icon's corners black on an iPhone. It is
// drawn full-bleed: the artwork carries its own margin, and iOS rounds the corners itself.
// Chromium is the renderer because it is already a dev dependency of the browser smoke tests.
//
//   node scripts/make-apple-touch-icon.mjs        # needs `playwright` (see CI: npm install --no-save playwright)

import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const size = 180
const background = "#ffffff"
const artworkScale = 1
const source = fileURLToPath(new URL("../public/icon-512.png", import.meta.url))
const target = fileURLToPath(new URL("../public/apple-touch-icon.png", import.meta.url))

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
try {
  const page = await browser.newPage()
  const dataUrl = await page.evaluate(async ({ png, size, background, artworkScale }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${png}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = size
    const context = canvas.getContext("2d")
    context.fillStyle = background
    context.fillRect(0, 0, size, size)
    context.imageSmoothingQuality = "high"
    const drawn = size * artworkScale
    context.drawImage(image, (size - drawn) / 2, (size - drawn) / 2, drawn, drawn)
    return canvas.toDataURL("image/png")
  }, { png: (await readFile(source)).toString("base64"), size, background, artworkScale })
  await writeFile(target, Buffer.from(dataUrl.split(",")[1], "base64"))
  console.log(`wrote ${target}`)
} finally {
  await browser.close()
}
