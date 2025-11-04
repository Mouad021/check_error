// =======================================================
// MILANO CHECK MAJORITY (server-side decision, client fetches)
// - POST /check-majority  { roomId?, targets:[{url}], results:[{url, ok, code, note}] }
//   -> returns { decision: true|false, success, total, ratio }
// - (اختياري) GET /targets  -> لائحة مسارات افتراضية إن حبيت تستخدمها
// =======================================================
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '500kb' }));

app.get('/', (_req, res) => res.send('MILANO CHECK MAJORITY running ✅'));

// (اختياري) قائمة أهداف افتراضية يمكن للعميل استعمالها إن أراد
app.get('/targets', (req, res) => {
  // لاحظ أن client سيستبدل BASE تلقائياً بـ location.origin ويضيف data لو متوفرة
  res.json({
    ok: true,
    targets: [
      "/MAR/home/index",
      "/MAR/account/Login",
      "/MAR/Appointment/VisaType?data={{DATA}}",
      "/MAR/Appointment/SlotSelection?data={{DATA}}",
      "/MAR/Appointment/ApplicantSelection/.js?data={{DATA}}"
    ]
  });
});

// قرار الأغلبية عبر الصفحات
app.post('/check-majority', (req, res) => {
  try {
    const body = req.body || {};
    const results = Array.isArray(body.results) ? body.results : [];

    const total = results.length;
    const success = results.filter(r => r && r.ok === true).length;

    // قاعدة: TRUE إذا النجاح > نصف الصفحات (أغلبية بسيطة)
    const decision = total > 0 ? (success > total / 2) : false;
    const ratio = total ? (success / total) : 0;

    return res.json({ ok: true, decision, success, total, ratio });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
