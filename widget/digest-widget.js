// ─────────────────────────────────────────────────────────────────────────────
// Slack Digest — Scriptable iOS Widget
// ─────────────────────────────────────────────────────────────────────────────
//
// HOW TO SET UP:
//   1. Install Scriptable (free) from the App Store
//   2. Start your summarizer server on your Mac
//   3. Check the terminal for:  📱  Widget API → http://192.168.x.x:3000/api/latest
//   4. Copy that IP address and update BASE_URL below
//   5. Paste this entire file into a new Scriptable script
//   6. Long-press your iPhone home screen → + → Scriptable → pick this script
//   7. Tap the widget → opens your Slack DM with the bot directly ⚡
//
// NOTE: Your iPhone and Mac must be on the same WiFi network.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'http://192.168.x.x:3000'; // ← Replace with your Mac's local IP

// ── Widget setup ──────────────────────────────────────────────────────────────
const widget = new ListWidget();
widget.backgroundColor = new Color('#1A1D21'); // Slack dark background
widget.setPadding(14, 16, 14, 16);

try {
  const req = new Request(`${BASE_URL}/api/latest`);
  req.timeoutInterval = 5;
  const data = await req.loadJSON();

  // Tapping the widget opens the Slack DM with the bot
  widget.url = data.slackLink || 'slack://';

  if (!data.hasData) {
    // First run — no digest yet
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const icon = row.addText('🌅');
    icon.font = Font.systemFont(28);

    row.addSpacer(10);

    const col = row.addStack();
    col.layoutVertically();

    const t1 = col.addText('No digest yet');
    t1.textColor = Color.white();
    t1.font      = Font.boldSystemFont(14);

    const t2 = col.addText('Tap to open Slack');
    t2.textColor = new Color('#ABABAD');
    t2.font      = Font.systemFont(11);

  } else {
    // Header row
    const headerRow = widget.addStack();
    headerRow.layoutHorizontally();
    headerRow.centerAlignContent();

    const headerText = headerRow.addText('⚡ Slack Digest');
    headerText.textColor = new Color('#E8E8E8');
    headerText.font      = Font.boldSystemFont(13);

    headerRow.addSpacer();

    const timeText = headerRow.addText(data.lastSummaryIST);
    timeText.textColor = new Color('#ABABAD');
    timeText.font      = Font.systemFont(10);

    widget.addSpacer(6);

    // Tagged mentions (if any)
    if (data.tagged) {
      const tagRow = widget.addStack();
      tagRow.layoutHorizontally();
      tagRow.centerAlignContent();
      tagRow.backgroundColor = new Color('#2C1A1A');
      tagRow.cornerRadius    = 6;
      tagRow.setPadding(5, 8, 5, 8);

      const tagText = tagRow.addText('👋 ' + data.tagged.slice(0, 90));
      tagText.textColor = new Color('#ECB22E');
      tagText.font      = Font.systemFont(11);
      tagText.lineLimit = 2;

      widget.addSpacer(5);
    }

    // Summary body
    const preview = (data.summary || 'All quiet — your channels are napping 😴').slice(0, 180);
    const body    = widget.addText(preview);
    body.textColor = Color.white();
    body.font      = Font.systemFont(12);
    body.lineLimit = 5;
  }

} catch (e) {
  // Server offline fallback — still opens Slack
  widget.url = 'slack://';

  const errRow = widget.addStack();
  errRow.layoutHorizontally();
  errRow.centerAlignContent();

  const errIcon = errRow.addText('🔌');
  errIcon.font = Font.systemFont(24);

  errRow.addSpacer(10);

  const errCol = errRow.addStack();
  errCol.layoutVertically();

  const e1 = errCol.addText('Server offline');
  e1.textColor = new Color('#E01E5A');
  e1.font      = Font.boldSystemFont(13);

  const e2 = errCol.addText('Tap to open Slack');
  e2.textColor = new Color('#ABABAD');
  e2.font      = Font.systemFont(11);
}

// Footer
widget.addSpacer();
const footer = widget.addText('Tap to open in Slack →');
footer.textColor = new Color('#4A4A4A');
footer.font      = Font.systemFont(9);

// ── Present ───────────────────────────────────────────────────────────────────
Script.setWidget(widget);
widget.presentMedium();
Script.complete();
