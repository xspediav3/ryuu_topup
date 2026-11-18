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



// ================= KONFIGURASI MYQRIS =================

const MYQRIS_BASE = process.env.MYQRIS_BASE_URL || "https://myqris.biz.id";
const MYQRIS_API_KEY = process.env.MYQRIS_API_KEY || "";

const DEPOSIT_BACKGROUND = "https://files.catbox.moe/mbhgwo.png";

const DEPOSIT_EXPIRED = 15 * 60 * 1000;
const DEPOSIT_POLLING = 5000;

const activeIntervals = new Map();
const processingDeposits = new Set();

// ================= AXIOS MYQRIS =================

const myQris = axios.create({
  baseURL: MYQRIS_BASE,
  timeout: 15000,
  headers: {
    "x-api-key": MYQRIS_API_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json"
  }
});

// ================= GENERATE BACKGROUND QRIS =================

async function generateCustomQrisImage(qrisImageUrl) {
  try {
    const [bgImage, qrisImage] = await Promise.all([
      loadImage(DEPOSIT_BACKGROUND),
      loadImage(qrisImageUrl)
    ]);

    const canvas = createCanvas(bgImage.width, bgImage.height);
    const ctx = canvas.getContext("2d");

    // Background
    ctx.drawImage(
      bgImage,
      0,
      0,
      bgImage.width,
      bgImage.height
    );

    // QRIS
    const qrisSize = 550;
    const xPos = (bgImage.width - qrisSize) / 2;
    const yPos = 575;

    ctx.drawImage(
      qrisImage,
      xPos,
      yPos,
      qrisSize,
      qrisSize
    );

    // Hasil PNG Base64
    return canvas.toDataURL("image/png");

  } catch (error) {
    console.error(
      "[MYQRIS] Generate Background Error:",
      error.message
    );

    return null;
  }
}

// ================= HELPER RESPONSE API =================

function getMyQrisData(response) {
  const data = response?.data || {};

  return data.deposit || data.data || data;
}

// ================= FORMAT STATUS =================

function normalizeDepositStatus(status) {
  const value = String(status || "").toLowerCase();

  if (["paid", "success", "completed"].includes(value)) {
    return "success";
  }

  if (["cancelled", "canceled"].includes(value)) {
    return "cancel";
  }

  return value || "pending";
}

// ================= CEK STATUS MYQRIS =================

async function checkMyQrisStatus(invoiceId) {
  const response = await myQris.post(
    "/api/deposit/status",
    {
      ref: invoiceId
    }
  );

  const data = getMyQrisData(response);

  return {
    ...data,
    status: normalizeDepositStatus(data.status)
  };
}

// ================= FORMAT RESPONSE DEPOSIT =================

function formatDepositResponse(data, id) {
  const nominal = Number(data.nominal) || 0;

  const kodeUnik = Number(
    data.kode_unik || data.tambahan || data.fee
  ) || 0;

  const totalAmount = Number(data.total_amount) ||
    (nominal + kodeUnik);

  return {
    id,
    trx_id: id,
    reff_id: data.reff_id || id,

    nominal,
    kode_unik: kodeUnik,
    tambahan: kodeUnik,
    fee: kodeUnik,
    fee_env: kodeUnik,
    fee_provider: 0,

    total_amount: totalAmount,
    get_balance: Number(data.get_balance) || nominal,

    status: normalizeDepositStatus(data.status),
    metode: data.metode || "QRIS",

    qr_image: data.qr_image || null,
    bg_image: data.bg_image || DEPOSIT_BACKGROUND,
    qris_string: data.qris_string || "",

    created_at: data.created_at || null,
    expires_at: data.provider_expires_at || null,

    paid_at: data.provider_time || null,

    provider_id: data.provider_id || null,
    provider_reference_id: data.provider_reference_id || null,
    provider_amount: Number(data.provider_amount) || totalAmount,
    provider_status: data.provider_status || null,
    provider_time: data.provider_time || null
  };
}

// ================= PROSES STATUS DAN SALDO =================

async function processMyQrisStatus(userId, invoiceId) {
  if (processingDeposits.has(invoiceId)) {
    return false;
  }

  processingDeposits.add(invoiceId);

  try {
    const userHistory = await User.findOne(
      {
        _id: userId,
        "historyDeposit.id": invoiceId
      },
      {
        "historyDeposit.$": 1
      }
    );

    const deposit = userHistory?.historyDeposit?.[0];

    if (
      !deposit ||
      !["pending", "processing"].includes(
        String(deposit.status).toLowerCase()
      )
    ) {
      return false;
    }

    const providerData = await checkMyQrisStatus(invoiceId);
    const providerStatus = providerData.status;

    if (providerStatus === "success") {
      const paidAt = providerData.paid_at ||
        providerData.paidAt ||
        new Date().toISOString();

      const updateResult = await User.updateOne(
        {
          _id: userId,
          historyDeposit: {
            $elemMatch: {
              id: invoiceId,
              status: {
                $in: ["pending", "processing"]
              }
            }
          }
        },
        {
          $set: {
            "historyDeposit.$.status": "success",
            "historyDeposit.$.provider_status": "success",
            "historyDeposit.$.provider_id": String(
              providerData.id || invoiceId
            ),
            "historyDeposit.$.provider_reference_id": String(
              providerData.ref ||
              providerData.reference_id ||
              invoiceId
            ),
            "historyDeposit.$.provider_amount":
              Number(providerData.amount) || Number(deposit.total_amount),

            "historyDeposit.$.provider_time": paidAt
          },
          $inc: {
            saldo: Number(deposit.get_balance) ||
              Number(deposit.nominal) || 0
          }
        }
      );

      if (updateResult.modifiedCount > 0) {
        console.log(`[MYQRIS] Deposit SUCCESS: ${invoiceId}`);
      }

      return updateResult.modifiedCount > 0;
    }

    if (["failed", "expired", "cancel"].includes(providerStatus)) {
      await User.updateOne(
        {
          _id: userId,
          historyDeposit: {
            $elemMatch: {
              id: invoiceId,
              status: {
                $in: ["pending", "processing"]
              }
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

      return false;
    }

    return false;

  } catch (error) {
    console.error(
      "[MYQRIS] Status Error:",
      error.response?.data || error.message
    );

    return false;

  } finally {
    processingDeposits.delete(invoiceId);
  }
}

// ================= STOP POLLING =================

function stopDepositPolling(invoiceId) {
  const interval = activeIntervals.get(invoiceId);

  if (interval) {
    clearInterval(interval);
    activeIntervals.delete(invoiceId);
  }
}

// ================= AUTO POLLING =================

function startDepositPolling(userId, invoiceId) {
  stopDepositPolling(invoiceId);

  const interval = setInterval(async () => {
    try {
      const userHistory = await User.findOne(
        {
          _id: userId,
          "historyDeposit.id": invoiceId
        },
        {
          "historyDeposit.$": 1
        }
      );

      const deposit = userHistory?.historyDeposit?.[0];

      if (
        !deposit ||
        !["pending", "processing"].includes(
          String(deposit.status).toLowerCase()
        )
      ) {
        stopDepositPolling(invoiceId);
        return;
      }

      await processMyQrisStatus(userId, invoiceId);

      const refreshed = await User.findOne(
        {
          _id: userId,
          "historyDeposit.id": invoiceId
        },
        {
          "historyDeposit.$": 1
        }
      );

      const status = String(
        refreshed?.historyDeposit?.[0]?.status || ""
      ).toLowerCase();

      if (!["pending", "processing"].includes(status)) {
        stopDepositPolling(invoiceId);
      }

    } catch (error) {
      console.error(
        "[MYQRIS] Polling Error:",
        error.message
      );
    }
  }, DEPOSIT_POLLING);

  activeIntervals.set(invoiceId, interval);

  setTimeout(() => {
    stopDepositPolling(invoiceId);
  }, DEPOSIT_EXPIRED + 60000);
}

// ======================================================
// CREATE DEPOSIT
// ======================================================

Router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { nominal } = req.body;
    const parsedNominal = Number(nominal);

    if (
      nominal === undefined ||
      nominal === null ||
      String(nominal).trim() === "" ||
      !Number.isSafeInteger(parsedNominal) ||
      parsedNominal < 10
    ) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp10"
      });
    }

    if (!MYQRIS_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key MyQris belum dikonfigurasi."
      });
    }

    // Kode unik Rp1 - Rp250
    const kodeUnik = Math.floor(Math.random() * 250) + 1;

    const totalBayar = parsedNominal + kodeUnik;
    const saldoDiterima = parsedNominal;

    // Nama pelanggan
    const customerName =
      user.username ||
      user.name ||
      user.nama ||
      "Customer";

    // CREATE MYQRIS
    let response;

    try {
      response = await myQris.post(
        "/api/deposit/create",
        {
          amount: totalBayar,
          customer_id: String(user._id),
          customer_name: customerName
        }
      );

    } catch (error) {
      console.error(
        "[MYQRIS] Create Error:",
        error.response?.data || error.message
      );

      return res.status(502).json({
        success: false,
        message:
          error.response?.data?.message ||
          "Gagal menghubungi server MyQris."
      });
    }

    const paymentData = getMyQrisData(response);

    const invoiceId = paymentData.id || paymentData.trx_id;

    const qrisUrl =
      paymentData.qr_code_url ||
      paymentData.qris_url;

    if (!invoiceId || !qrisUrl) {
      console.error(
        "[MYQRIS] Response tidak lengkap:",
        response.data
      );

      return res.status(502).json({
        success: false,
        message: "MyQris tidak mengembalikan ID transaksi atau QRIS."
      });
    }

    // Generate gambar QRIS + background
    const customQrisImage =
      await generateCustomQrisImage(qrisUrl);

    // Jika canvas gagal, gunakan QRIS asli
    const finalQrImage = customQrisImage || qrisUrl;

    const createdAt = new Date();

    const expiresAt = new Date(
      createdAt.getTime() + DEPOSIT_EXPIRED
    );

    const customBgUrl = DEPOSIT_BACKGROUND;

    // Data history
    const historyDataForDb = {
      id: String(invoiceId),
      reff_id: String(invoiceId),

      nominal: parsedNominal,
      tambahan: kodeUnik,
      kode_unik: kodeUnik,

      fee: kodeUnik,
      fee_env: kodeUnik,
      fee_provider: 0,

      total_amount: totalBayar,
      get_balance: saldoDiterima,

      provider_amount: Number(paymentData.amount) || totalBayar,

      provider: "myqris",
      provider_id: String(invoiceId),
      provider_reference_id: String(invoiceId),

      provider_created_at: createdAt.toISOString(),
      provider_expires_at: expiresAt.toISOString(),

      expires_in_ms: DEPOSIT_EXPIRED,

      provider_status: "pending",
      provider_time: null,

      qris_string: paymentData.qris_string || "",

      metode: "QRIS",
      status: "pending",

      qr_image: finalQrImage,
      bg_image: customBgUrl,

      created_at: createdAt
    };

    await tambahHistoryDeposit(
      user._id,
      historyDataForDb
    );

    // Jalankan polling otomatis setiap 5 detik
    startDepositPolling(user._id, String(invoiceId));

    return res.status(200).json({
      success: true,

      data: {
        id: String(invoiceId),
        trx_id: String(invoiceId),
        reff_id: String(invoiceId),

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
        qris_url: qrisUrl,

        qris_string: paymentData.qris_string || "",

        bg_image: customBgUrl,

        status: "pending",

        expires_at: expiresAt.toISOString(),
        expires_in_ms: DEPOSIT_EXPIRED
      }
    });

  } catch (error) {
    console.error("[MYQRIS] Deposit Create Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ======================================================
// CEK STATUS DEPOSIT
// ======================================================

Router.post("/deposit/status", requireLogin, async (req, res) => {
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

    let userHistory = await User.findOne(
      {
        _id: user._id,
        "historyDeposit.id": id
      },
      {
        "historyDeposit.$": 1
      }
    );

    if (!userHistory?.historyDeposit?.length) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan."
      });
    }

    let localData = userHistory.historyDeposit[0];

    let localStatus = String(
      localData.status || "pending"
    ).toLowerCase();

    // Jika masih pending, cek langsung ke MyQris
    if (["pending", "processing"].includes(localStatus)) {
      await processMyQrisStatus(user._id, id);
    }

    // Ambil data terbaru dari database
    const refreshedUser = await User.findOne(
      {
        _id: user._id,
        "historyDeposit.id": id
      },
      {
        "historyDeposit.$": 1
      }
    );

    localData =
      refreshedUser?.historyDeposit?.[0] || localData;

    localStatus = String(
      localData.status || "pending"
    ).toLowerCase();

    // Hentikan polling jika status sudah final
    if (!["pending", "processing"].includes(localStatus)) {
      stopDepositPolling(id);
    }

    return res.status(200).json({
      success: true,

      data: formatDepositResponse(localData, id)
    });

  } catch (error) {
    console.error(
      "[MYQRIS] Deposit Status Error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      message: "Gagal memuat detail terbaru."
    });
  }
});

// ======================================================
// CANCEL DEPOSIT
// ======================================================

Router.post("/deposit/cancel", requireLogin, async (req, res) => {
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

    const userHistory = await User.findOne(
      {
        _id: user._id,
        "historyDeposit.id": id
      },
      {
        "historyDeposit.$": 1
      }
    );

    if (!userHistory?.historyDeposit?.length) {
      return res.status(404).json({
        success: false,
        message: "Data transaksi tidak ditemukan."
      });
    }

    const currentData = userHistory.historyDeposit[0];

    if (
      !["pending", "processing"].includes(
        String(currentData.status).toLowerCase()
      )
    ) {
      return res.status(400).json({
        success: false,
        message: `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.`
      });
    }

    // Minta pembatalan ke MyQris
    try {
      await myQris.post(
        "/api/cancel",
        {
          ref: id
        }
      );

    } catch (error) {
      console.error(
        "[MYQRIS] Cancel API Error:",
        error.response?.data || error.message
      );

      return res.status(502).json({
        success: false,
        message:
          error.response?.data?.message ||
          "Gagal membatalkan transaksi di MyQris."
      });
    }

    // Update database hanya jika masih pending
    const updateResult = await User.updateOne(
      {
        _id: user._id,
        historyDeposit: {
          $elemMatch: {
            id,
            status: {
              $in: ["pending", "processing"]
            }
          }
        }
      },
      {
        $set: {
          "historyDeposit.$.status": "cancel",
          "historyDeposit.$.provider_status": "cancel"
        }
      }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(409).json({
        success: false,
        message: "Status transaksi sudah berubah. Silakan cek status terbaru."
      });
    }

    stopDepositPolling(id);

    return res.status(200).json({
      success: true,
      message: "Deposit berhasil dibatalkan.",
      data: {
        id,
        status: "cancel"
      }
    });

  } catch (error) {
    console.error("[MYQRIS] Cancel Error:", error);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan: " + error.message
    });
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
