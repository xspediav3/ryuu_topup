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
        metode: "QRIS",
        type: "ewallet",
        name: "QRIS All Payment (Otomatis)",
        min: 10,
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

const BACKGROUND_URL = "https://files.catbox.moe/mbhgwo.png";

// ================= FUNGSI KODE UNIK BERTINGKAT =================
function generateUniqueCode(amount) {
  const parsed = parseInt(amount, 10);
  if (parsed >= 1 && parsed <= 999) {
    return Math.floor(Math.random() * 200) + 1; // Rp1 - Rp200
  } else if (parsed >= 1000 && parsed <= 10000) {
    return Math.floor(Math.random() * 301) + 200; // Rp200 - Rp500
  } else if (parsed > 10000 && parsed <= 100000) {
    return Math.floor(Math.random() * 1001) + 500; // Rp500 - Rp1500
  }
  return Math.floor(Math.random() * 100) + 1;
}

// ================= MENGGABUNGKAN QRIS DENGAN BACKGROUND KUSTOM =================
async function generateCustomQrisImage(qrisImageUrl) {
  try {
    const [bgImage, qrisImage] = await Promise.all([
      loadImage(BACKGROUND_URL),
      loadImage(qrisImageUrl)
    ]);

    const canvas = createCanvas(bgImage.width, bgImage.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(bgImage, 0, 0, bgImage.width, bgImage.height);

    const qrisSize = 550;
    const xPos = (bgImage.width - qrisSize) / 2;
    const yPos = 575;

    ctx.drawImage(qrisImage, xPos, yPos, qrisSize, qrisSize);

    return canvas.toBuffer('image/png');
  } catch (error) {
    console.error('Gagal menggabungkan QRIS dengan background:', error.message);
    return null;
  }
}

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

    if (!nominal || !Number.isFinite(parsedNominal) || parsedNominal < 10) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp10"
      });
    }

    const XS_BASE = process.env.XS_PEDIA_BASE_URL || "https://xspedia-payment.vercel.app";

    // ================= KODE UNIK BERTINGKAT =================
    const kodeUnik = generateUniqueCode(parsedNominal);
    const totalBayar = parsedNominal + kodeUnik;
    const saldoDiterima = parsedNominal;

    // ================= CREATE XS-PEDIA (API v1) =================
    const createUrl = `${XS_BASE}/api/v1/payments`;

    let response;
    try {
      response = await fetch(createUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({
          amount: totalBayar
        })
      });
    } catch (fetchError) {
      console.error("XS-Pedia Create Fetch Error:", fetchError);
      return res.status(502).json({
        success: false,
        message: "Koneksi server ke XS-Pedia gagal."
      });
    }

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch (jsonError) {
      console.error("XS-Pedia Create Invalid Response:", responseText.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: "XS-Pedia mengembalikan response yang bukan JSON."
      });
    }

    if (!response.ok || !result?.success || !result?.data) {
      return res.status(400).json({
        success: false,
        message: result?.message || result?.error || "Gagal membuat QRIS XS-Pedia."
      });
    }

    // Mapping sesuai struktur response API v1 terbaru
    const paymentData = result.data;
    const rawQrImage = paymentData.qr || "";
    const qrisString = paymentData.qrisString || "";
    const providerPaymentId = paymentData.paymentId;
    
    // Parsing timestamp MS (epoch) dari response API
    const rawCreatedAt = paymentData.createdAt;
    const providerCreatedAt = rawCreatedAt 
      ? new Date(typeof rawCreatedAt === 'number' ? rawCreatedAt : rawCreatedAt).toISOString() 
      : new Date().toISOString();

    const rawExpiresAt = paymentData.expiresAt;
    const providerExpiresAt = rawExpiresAt
      ? new Date(typeof rawExpiresAt === 'number' ? rawExpiresAt : rawExpiresAt).toISOString()
      : null;

    if (!rawQrImage || !qrisString || !providerPaymentId) {
      return res.status(502).json({
        success: false,
        message: "XS-Pedia tidak mengembalikan QRIS / paymentId lengkap."
      });
    }

    // ================= ID TRANSAKSI MURNI DARI PAYMENT ID =================
    const localTrxId = providerPaymentId; // e.g. "xiao-api-483921"
    const customBgUrl = BACKGROUND_URL;

    // ================= GENERATE BACKGROUND KUSTOM (CANVAS) =================
    let finalQrImage = rawQrImage;
    try {
      const customBuffer = await generateCustomQrisImage(rawQrImage);
      if (customBuffer) {
        finalQrImage = `data:image/png;base64,${customBuffer.toString('base64')}`;
      }
    } catch (canvasErr) {
      console.error("Canvas Generation Warning:", canvasErr.message);
    }

    // ================= SIMPAN HISTORY =================
    const historyDataForDb = {
      id: localTrxId,
      reff_id: localTrxId,
      nominal: parsedNominal,
      tambahan: kodeUnik,
      kode_unik: kodeUnik,
      fee: kodeUnik,
      fee_env: kodeUnik,
      fee_provider: 0,
      total_amount: totalBayar,
      get_balance: saldoDiterima,
      provider_amount: paymentData.amount || totalBayar,
      provider: "xs-pedia",
      provider_id: providerPaymentId,
      provider_reference_id: providerPaymentId,
      provider_created_at: providerCreatedAt,
      provider_expires_at: providerExpiresAt,
      expires_in_ms: paymentData.expiresInMs || 900000,
      provider_status: paymentData.status || "pending",
      provider_time: null,
      qris_string: qrisString,
      metode: "QRIS",
      status: "pending",
      qr_image: finalQrImage,
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
        fee: kodeUnik,    
        fee_env: kodeUnik,    
        fee_provider: 0,    
        total_amount: totalBayar,    
        get_balance: saldoDiterima,    
        qr_image: finalQrImage,    
        qris_string: qrisString,    
        bg_image: customBgUrl,    
        status: paymentData.status || "pending",
        expires_at: providerExpiresAt,
        expires_in_ms: paymentData.expiresInMs || 900000
      }
    });

    // ================= BACKGROUND POLLING XS-PEDIA =================
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

        // Live status-check via POST ke /api/v1/payments/{paymentId}/status
        const detailUrl = `${XS_BASE}/api/v1/payments/${encodeURIComponent(localTrxId)}/status`;
        const checkRes = await fetch(detailUrl, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Accept": "application/json", 
            "User-Agent": "Mozilla/5.0" 
          },
          body: JSON.stringify({})
        });

        if (!checkRes.ok) return;

        const checkData = await checkRes.json();
        if (!checkData?.success || !checkData?.data) return;

        const providerTrx = checkData.data;
        const rawProviderStatus = String(providerTrx.status || "").toLowerCase();
        const providerStatus = rawProviderStatus === "paid" ? "success" : rawProviderStatus;

        if (providerStatus === "success") {
          let pTime = providerTrx.paidAt || providerTrx.createdAt || null;
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
                "historyDeposit.$.provider_reference_id": String(providerTrx.transactionId || providerTrx.id || localTrxId),
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
        console.error("XS-Pedia Polling Error:", e.message);
      }
    }, 10000);

    // Otomatis menghentikan polling sesuai durasi expired (default 15 menit)
    const timeoutMs = paymentData.expiresInMs || 15 * 60 * 1000;
    setTimeout(() => clearInterval(intervalId), timeoutMs + 60000);

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
          bg_image: localData.bg_image || BACKGROUND_URL,
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
        bg_image: localData.bg_image || BACKGROUND_URL,
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
