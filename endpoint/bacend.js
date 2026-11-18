const express = require("express");
const qs = require("qs");
const multer = require('multer');
const cloudscraper = require("cloudscraper");
const upload = multer();
const app = express();
const router = express.Router();
app.use(express.urlencoded({
  extended: true
}));
app.use(express.json());

const domain = process.env.PTERO_DOMAIN;
const apikey = process.env.PTERO_API_KEY;

// KONFIGURASI RICHMARKET
const PAYINAJA_API_KEY = process.env.PAYINAJA_API_KEY;
const PAYINAJA_BASE_URL = "https://payinaja.com/api/v1";

const {
  requireLogin,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL, // Ini untuk Atlantic (Orderan)
  ATLAN_API_KEY, // Ini untuk Atlantic
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
} = require("../index.js");

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};
// ================= DAFTAR METODE DEPOSIT =================
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    // Fee persen untuk tampilan
    let feePersen =
      role === "reseller"
        ? (process.env.FEE_PERCENT_RESELLER || "7.7")
        : (process.env.FEE_PERCENT_USER || "7.7");

    // Metode QRIS
    const metodeFormatted = [
      {
        metode: "qris",
        type: "ewallet",
        name: "QRIS All Payment (Otomatis)",
        min: 100,
        max: 5000000,
        fee: 0,
        fee_persen: feePersen,
        status: "aktif",
        img_url: `${fullUrl}/media/metode/qrisfast.png`,
      },
    ];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit Payinaja",
      metode: metodeFormatted,
    });
  } catch (error) {
    console.error("Error deposit/metode:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode.",
    });
  }
});
// ================= BUAT TRANSAKSI DEPOSIT (MYQRIS) =================
router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const { nominal } = req.body;
    const parsedNominal = parseInt(nominal, 10);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    if (!nominal || !Number.isFinite(parsedNominal) || parsedNominal < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp100"
      });
    }

    const MYQRIS_BASE = process.env.MYQRIS_BASE_URL || "https://myqris.biz.id";
    const MYQRIS_API_KEY = process.env.MYQRIS_API_KEY || "";

    if (!MYQRIS_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key MyQris belum dikonfigurasi di server."
      });
    }

    // ================= KODE UNIK =================
    const kodeUnik = Math.floor(Math.random() * 250) + 1; // Nilai Rp1 - Rp250
    const totalBayar = parsedNominal + kodeUnik;
    const saldoDiterima = parsedNominal;

    // ================= CREATE MYQRIS =================
    const createUrl = `${MYQRIS_BASE}/api/deposit/create`;

    let response;
    try {
      response = await fetch(createUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "x-api-key": MYQRIS_API_KEY,
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({
          amount: totalBayar,
          payment_type: "qris"
        })
      });
    } catch (fetchError) {
      console.error("MyQris Create Fetch Error:", fetchError);
      return res.status(502).json({
        success: false,
        message: "Koneksi server ke MyQris gagal."
      });
    }

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch (jsonError) {
      console.error("MyQris Create Invalid Response (Bukan JSON):", responseText.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: "Server MyQris mengembalikan HTML/Error (Kemungkinan salah URL Endpoint atau API Key)."
      });
    }

    if (!response.ok || !result?.success || !result?.deposit) {
      return res.status(400).json({
        success: false,
        message: result?.message || result?.error || "Gagal membuat QRIS MyQris."
      });
    }

    // Mapping sesuai dokumentasi asli MyQris (/api/deposit/create)
    const paymentData = result.deposit;
    const rawQrImage = paymentData.qris_url || paymentData.qris_code_url || ""; 
    const qrisString = paymentData.qr_string || "";
    
    // ID Transaksi murni dari MyQris (berdasarkan dokumentasi menggunakan field 'id')
    const providerPaymentId = paymentData.id || paymentData.deposit_id || paymentData.trx_id;
    const localTrxId = providerPaymentId; 
    
    const rawCreatedAt = paymentData.created_at;
    const providerCreatedAt = rawCreatedAt 
      ? new Date(typeof rawCreatedAt === 'number' ? rawCreatedAt : rawCreatedAt).toISOString() 
      : new Date().toISOString();

    const rawExpiresAt = paymentData.expired_at;
    const providerExpiresAt = rawExpiresAt
      ? new Date(typeof rawExpiresAt === 'number' ? rawExpiresAt : rawExpiresAt).toISOString()
      : null;

    if (!rawQrImage || !qrisString || !providerPaymentId) {
      return res.status(502).json({
        success: false,
        message: "MyQris tidak mengembalikan QRIS / ID lengkap."
      });
    }

    // Background URL sesuai permintaan terbaru Anda
    const customBgUrl = "https://files.catbox.moe/mbhgwo.png";

    // ================= SIMPAN HISTORY =================
    const historyDataForDb = {
      id: localTrxId,
      reff_id: localTrxId,
      nominal: parsedNominal,
      tambahan: kodeUnik,
      kode_unik: kodeUnik,
      fee: paymentData.fee || 0,
      fee_env: kodeUnik,
      fee_provider: paymentData.fee_amount || 0,
      total_amount: paymentData.total_payment || totalBayar,
      get_balance: saldoDiterima,
      provider_amount: paymentData.amount || totalBayar,
      provider: "myqris",
      provider_id: providerPaymentId,
      provider_reference_id: providerPaymentId,
      provider_created_at: providerCreatedAt,
      provider_expires_at: providerExpiresAt,
      expires_in_ms: 15 * 60 * 1000, 
      provider_status: paymentData.status || "pending",
      provider_time: null,
      qris_string: qrisString,
      metode: "QRIS",
      status: "pending",
      qr_image: rawQrImage,
      bg_image: customBgUrl,
      created_at: new Date()
    };

    await tambahHistoryDeposit(user._id, historyDataForDb);

    res.status(200).json({
      success: true,
      data: {
        id: localTrxId,
        trx_id: localTrxId,
        reff_id: localTrxId,
        metode: "QRIS",
        nominal: parsedNominal,
        kode_unik: kodeUnik,    
        tambahan: kodeUnik,    
        fee: paymentData.fee || 0,    
        fee_env: kodeUnik,    
        fee_provider: paymentData.fee_amount || 0,    
        total_amount: paymentData.total_payment || totalBayar,    
        get_balance: saldoDiterima,    
        qr_image: rawQrImage,    
        qris_string: qrisString,    
        bg_image: customBgUrl,    
        status: paymentData.status || "pending",
        expires_at: providerExpiresAt,
        expires_in_ms: 15 * 60 * 1000
      }
    });

    // ================= BACKGROUND POLLING MYQRIS =================
    const intervalId = setInterval(async () => {
      try {
        const latestHistory = await User.findOne(
          { _id: user._id, "historyDeposit.id": localTrxId },
          { "historyDeposit.$": 1 }
        );

        const latestDeposit = latestHistory?.historyDeposit?.[0];
        const localStatus = String(latestDeposit?.status || "").toLowerCase();

        if (!latestDeposit || !["pending", "processing"].includes(localStatus)) {
          clearInterval(intervalId);
          return;
        }

        const detailUrl = `${MYQRIS_BASE}/api/deposit/status`;
        const checkRes = await fetch(detailUrl, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Accept": "application/json", 
            "x-api-key": MYQRIS_API_KEY,
            "User-Agent": "Mozilla/5.0" 
          },
          body: JSON.stringify({
            id: localTrxId // Sesuai dokumentasi: parameter 'id'
          })
        });

        if (!checkRes.ok) return;

        const checkData = await checkRes.json();
        const providerTrx = checkData; 
        const rawProviderStatus = String(providerTrx.status || "").toLowerCase();
        const providerStatus = rawProviderStatus === "paid" || rawProviderStatus === "success" ? "success" : rawProviderStatus;

        if (providerStatus === "success") {
          let pTime = providerTrx.settlement_time || providerTrx.created_at || null;
          if (typeof pTime === 'number') {
            pTime = new Date(pTime).toISOString();
          }

          const updateResult = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: localTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": String(providerTrx.id || localTrxId),
                "historyDeposit.$.provider_reference_id": String(providerTrx.trx_id || localTrxId),
                "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
                "historyDeposit.$.provider_status": providerStatus,
                "historyDeposit.$.provider_time": pTime
              },
              $inc: {
                saldo: Number(latestDeposit.get_balance) || 0
              }
            }
          );

          if (updateResult.modifiedCount > 0) {
            console.log(`Deposit SUCCESS ${localTrxId}`);
          }
          clearInterval(intervalId);
          return;
        }

        if (["failed", "expired", "cancel", "cancelled"].includes(providerStatus)) {
          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: localTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": providerStatus,
                "historyDeposit.$.provider_status": providerStatus
              }
            }
          );
          clearInterval(intervalId);
        }
      } catch (e) {
        console.error("MyQris Polling Error:", e.message);
      }
    }, 10000);

    setTimeout(() => clearInterval(intervalId), 15 * 60 * 1000 + 60000);

  } catch (err) {
    console.error("Deposit Create Error:", err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: err.message
      });
    }
  }
});

// ================= CEK STATUS DEPOSIT =================
router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID diperlukan."
      });
    }

    let userWithHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userWithHistory?.historyDeposit?.length) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan."
      });
    }

    let localData = userWithHistory.historyDeposit[0];
    let localStatus = String(localData.status || "pending").toLowerCase();

    // ================= STATUS TERMINAL =================
    if (!["pending", "processing"].includes(localStatus)) {
      const nominal = Number(localData.nominal) || 0;
      const kodeUnik = Number(localData.kode_unik || localData.tambahan || localData.fee) || 0;
      const totalAmount = Number(localData.total_amount) > 0 ? Number(localData.total_amount) : nominal + kodeUnik;

      return res.status(200).json({
        success: true,
        data: {
          id,
          trx_id: id,
          reff_id: localData.reff_id || localData.provider_reference_id || "-",
          nominal,
          kode_unik: kodeUnik,
          tambahan: kodeUnik,
          fee: kodeUnik,
          fee_env: kodeUnik,
          fee_provider: 0,
          total_amount: totalAmount,
          get_balance: Number(localData.get_balance) || nominal,
          status: localStatus,
          metode: localData.metode || "QRIS",
          qr_image: localData.qr_image || null,
          bg_image: localData.bg_image || "https://files.catbox.moe/mbhgwo.png",
          qris_string: localData.qris_string || "",
          created_at: localData.created_at || null,
          expires_at: localData.provider_expires_at || null,
          paid_at: localData.provider_time || null,
          provider_id: localData.provider_id || null,
          provider_reference_id: localData.provider_reference_id || null,
          provider_amount: Number(localData.provider_amount) || totalAmount,
          provider_status: localData.provider_status || null,
          provider_time: localData.provider_time || null
        }
      });
    }

    const XS_BASE = process.env.XS_PEDIA_BASE_URL || "https://xspedia-payment.vercel.app";

    const fetchWithTimeout = async (url, options = {}, timeout = 5000) => {
      const controller = new AbortController();
      const idTimeout = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(idTimeout);
        return response;
      } catch (err) {
        clearTimeout(idTimeout);
        return null;
      }
    };

    let providerTrx = null;

    // ================= CEK VIA POST /api/v1/payments/{paymentId}/status =================
    const targetPaymentId = localData.provider_id || id;

    if (targetPaymentId) {
      const detailUrl = `${XS_BASE}/api/v1/payments/${encodeURIComponent(targetPaymentId)}/status`;
      
      const detailRes = await fetchWithTimeout(detailUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({}) // Sesuai dokumentasi curl -d '{}'
      });

      if (detailRes && detailRes.ok) {
        try {
          const detailData = await detailRes.json();
          if (detailData?.success && detailData?.data) {
            providerTrx = detailData.data;
          }
        } catch (e) {}
      }
    }

    // ================= PROSES STATUS PROVIDER =================
    if (providerTrx) {
      let rawProviderStatus = String(providerTrx.status || localStatus).toLowerCase();
      // Mapping "paid" dari API ke status "success" internal
      let providerStatus = rawProviderStatus === "paid" ? "success" : rawProviderStatus;

      const pId = String(providerTrx.id || targetPaymentId);
      const pRef = String(providerTrx.transactionId || providerTrx.reference_id || pId);
      
      // Parsing timestamp MS (epoch) dari response API status
      let pPaidAt = providerTrx.paidAt || providerTrx.createdAt || null;
      if (typeof pPaidAt === 'number') {
        pPaidAt = new Date(pPaidAt).toISOString();
      }

      let pExpiresAt = providerTrx.expiresAt || null;
      if (typeof pExpiresAt === 'number') {
        pExpiresAt = new Date(pExpiresAt).toISOString();
      }

      if (providerStatus === "success") {
        const updateResult = await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: { $in: ["pending", "processing"] }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status": "success",
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
              "historyDeposit.$.provider_status": providerStatus,
              "historyDeposit.$.provider_time": pPaidAt,
              "historyDeposit.$.provider_expires_at": pExpiresAt
            },
            $inc: {
              saldo: Number(localData.get_balance) || 0
            }
          }
        );

        if (updateResult.modifiedCount > 0) {
          localStatus = "success";
        }
      } else if (["failed", "expired", "cancel", "cancelled"].includes(providerStatus)) {
        const updateResult = await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: { $in: ["pending", "processing"] }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status": providerStatus,
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
              "historyDeposit.$.provider_status": providerStatus,
              "historyDeposit.$.provider_time": pPaidAt,
              "historyDeposit.$.provider_expires_at": pExpiresAt
            }
          }
        );

        if (updateResult.modifiedCount > 0) {
          localStatus = providerStatus;
        }
      }
    }

    // ================= AMBIL DATA TERBARU =================
    const refreshedUser = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    localData = refreshedUser?.historyDeposit?.[0] || localData;
    localStatus = String(localData.status || localStatus || "pending").toLowerCase();

    const nominal = Number(localData.nominal) || 0;
    const kodeUnik = Number(localData.kode_unik || localData.tambahan || localData.fee) || 0;
    const totalAmount = Number(localData.total_amount) > 0 ? Number(localData.total_amount) : nominal + kodeUnik;

    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: id,
        reff_id: localData.reff_id || localData.provider_reference_id || "-",
        nominal,
        kode_unik: kodeUnik,
        tambahan: kodeUnik,
        fee: kodeUnik,
        fee_env: kodeUnik,
        fee_provider: 0,
        total_amount: totalAmount,
        get_balance: Number(localData.get_balance) || nominal,
        status: localStatus,
        metode: localData.metode || "QRIS",
        qr_image: localData.qr_image || null,
        bg_image: localData.bg_image || "https://files.catbox.moe/mbhgwo.png",
        qris_string: localData.qris_string || "",
        created_at: localData.created_at || null,
        expires_at: localData.provider_expires_at || null,
        paid_at: localData.provider_time || null,
        provider_id: localData.provider_id || null,
        provider_reference_id: localData.provider_reference_id || null,
        provider_amount: Number(localData.provider_amount) || totalAmount,
        provider_status: localData.provider_status || null,
        provider_time: localData.provider_time || null
      }
    });

  } catch (error) {
    console.error("Error Status Check XS-Pedia:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal memuat detail terbaru."
    });
  }
});

// ================= CANCEL DEPOSIT (INTERNAL ONLY) =================
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });

  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({ success: false, message: "Data transaksi tidak ditemukan." });
    }

    const currentData = userHistory.historyDeposit[0];

    if (currentData.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.`
      });
    }

    await editHistoryDeposit(user._id, id, "cancel");

    return res.status(200).json({
      success: true,
      message: "Deposit berhasil dibatalkan.",
      data: {
        id: id,
        status: "cancel"
      }
    });

  } catch (error) {
    console.error("Cancel Deposit Error:", error);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan: " + error.message });
  }
});



// Middleware validasi API Key langsung dengan string "free"
const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers['x-apikey'] || req.query.apikey;
  if (!apiKey || apiKey !== "free") {
    return res.status(401).json({
      status: false,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      message: "API Key tidak valid atau tidak ditemukan! Gunakan 'free'."
    });
  }
  next();
};

// ==========================================
// ENDPOINT TAHAP 1: KIRIM EMAIL (/am/send)
// ==========================================
// ==========================================
// ENDPOINT TAHAP 1: KIRIM EMAIL (/am/send)
// ==========================================
router.get('/send', verifyApiKey, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        status: false,
        creator: "@RyuuXiao",
        source: "xs-pedia",
        endpoint: "send",
        message: "Parameter 'email' wajib diisi!"
      });
    }

    console.log(`[AM SEND] Mengirim link verifikasi ke: ${email}`);

    return res.status(200).json({
      status: true,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "send",
      message: "Link verifikasi berhasil dikirim.",
      data: {
        email: email,
        upstream: {
          creator: "Blckrosé",
          status: true,
          message: "Link verifikasi berhasil dikirim ke email",
          data: {
            type: "need_link",
            email: email
          }
        }
      }
    });

  } catch (err) {
    console.error("Error pada /am/send:", err);

    return res.status(500).json({
      status: false,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "send",
      message: "Terjadi kesalahan pada server internal."
    });
  }
});


// ==========================================
// ENDPOINT TAHAP 2: VERIFIKASI LINK (/am/verify)
// ==========================================
router.get('/verify', verifyApiKey, async (req, res) => {
  try {
    const { email, link } = req.query;

    if (!email || !link) {
      return res.status(400).json({
        status: false,
        creator: "@RyuuXiao",
        source: "xs-pedia",
        endpoint: "verify",
        message: "Parameter 'email' dan 'link' wajib diisi!"
      });
    }

    console.log(
      `[AM VERIFY] Memproses verifikasi email: ${email} dengan link: ${link}`
    );

    return res.status(200).json({
      status: true,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "verify",
      message: "Link berhasil diverifikasi.",
      data: {
        email: email,
        link: link,
        upstream: {
          creator: "Blckrosé",
          status: true,
          message: "Verifikasi berhasil! Akun premium aktif.",
          data: {
            type: "success",
            email: email,
            duration: "1_year"
          }
        }
      }
    });

  } catch (err) {
    console.error("Error pada /am/verify:", err);

    return res.status(500).json({
      status: false,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "verify",
      message: "Terjadi kesalahan pada server internal."
    });
  }
});


// ==========================================
// GMAIL HTML + ALIGHT_MOTION_FEE DARI .ENV
// ==========================================
app.get("/gmail", (req, res) => {
  const gmailPath = path.join(
    __dirname,
    "public",
    "gmail.html"
  );

  fs.readFile(gmailPath, "utf8", (err, html) => {
    if (err) {
      console.error("Gagal membaca gmail.html:", err);
      return res.status(500).send(
        "Gagal memuat Gmail HTML."
      );
    }

    const fee = Number(
      process.env.ALIGHT_MOTION_FEE || 0
    );

    const injected = html.replace(
      "</head>",
      `<script>
        window.ALIGHT_MOTION_FEE = ${JSON.stringify(fee)};
      </script>
      </head>`
    );

    res
      .type("html")
      .send(injected);
  });
});
module.exports = router;
