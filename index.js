const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");

// Import new performance modules
const {
  noLimiter,
  devLimiter,
  generalLimiter,
  authLimiter,
  paymentLimiter,
  uploadLimiter,
  searchLimiter,
  webhookLimiter,
} = require("./middleware/rateLimiter");

// Import new middleware
const { sanitizeContent } = require("./middleware/contentSanitizer");
const {
  upload,
  handleFileValidationError,
} = require("./middleware/fileValidator");
const {
  validateUrlMiddleware,
  rateLimitOgRequests,
  getCachedOgData,
  setCachedOgData,
} = require("./middleware/urlValidator");
const { processRequestData } = require("./middleware/dataProcessor");
const postsRouter = require("./routes/posts");
const clansRouter = require("./routes/clans");
const usersRouter = require("./routes/users");
const eventsRouter = require("./routes/events");
const paymentRouter = require("./routes/payment");
const leaderboardRouter = require("./routes/leaderboard");
const contactRouter = require("./routes/contact");
const { stripeWebhook } = require("./controllers/payment");

// ✅ NEW: Import production-grade routes
const analyticsRouter = require("./routes/analytics");
const searchRouter = require("./routes/search");
const gameScoresRouter = require("./routes/gameScores");
const gameReviewsRouter = require("./routes/gameReviews");
const gamesRouter = require("./routes/games");
const challengeRouter = require("./routes/challenges");
const notificationRouter = require("./routes/notifications");
const walletRouter = require("./routes/wallet");
const messagesRouter = require("./routes/messages");
const adminRouter = require("./routes/admin");
const migrationRouter = require("./routes/migration");

const app = express();
// Trust Vercel/Proxy to ensure req.ip is derived correctly for rate limiting
app.set("trust proxy", true);

// ============================================
// CORS CONFIGURATION - MUST BE FIRST
// ============================================
// This is critical for Vercel serverless functions
// CORS setup must happen before any other middleware

// Allow ngrok URLs for local development
const defaultOrigins = [
  // Development URLs
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5000",
  // Production URLs
  "https://hub.gametribe.com",
  "https://gametribe.com",
  "https://gt-server-mu.vercel.app",
];

// Add ngrok URL if provided
if (process.env.NGROK_URL) {
  defaultOrigins.push(process.env.NGROK_URL);
}

// Normalize origins (trim and lowercase for comparison)
const normalizeOrigin = (origin) =>
  origin.trim().toLowerCase().replace(/\/$/, "");

const allowedOriginsRaw = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").concat(defaultOrigins)
  : defaultOrigins;

// Normalize all origins for matching
const allowedOrigins = allowedOriginsRaw.map(normalizeOrigin);

console.log("🌐 CORS Allowed Origins (raw):", allowedOriginsRaw);
console.log("🌐 CORS Normalized Origins:", allowedOrigins);
console.log(
  "🌐 Checking for hub.gametribe.com (normalized):",
  allowedOrigins.includes(normalizeOrigin("https://hub.gametribe.com"))
);

// CORS origin validation function
const validateOrigin = (origin) => {
  if (!origin) {
    return true; // Allow requests with no origin (mobile apps)
  }

  const normalizedOrigin = normalizeOrigin(origin);

  // Check normalized match
  if (allowedOrigins.includes(normalizedOrigin)) {
    console.log("✅ CORS: Origin allowed:", origin);
    return true;
  }

  // In development, allow any ngrok URL
  if (
    (process.env.NODE_ENV === "development" || !process.env.NODE_ENV) &&
    (origin.includes("ngrok-free.app") || origin.includes("ngrok.io"))
  ) {
    console.log("✅ CORS: Ngrok origin allowed in development:", origin);
    return true;
  }

  console.log("❌ CORS: Origin blocked:", origin);
  console.log("❌ CORS: Normalized origin:", normalizedOrigin);
  console.log("❌ CORS: Allowed origins:", allowedOrigins);
  return false;
};

// Explicit OPTIONS handler for Vercel serverless (FIRST middleware)
// This is critical for Vercel as it handles OPTIONS requests differently
app.use((req, res, next) => {
  // Log all OPTIONS requests for debugging
  if (req.method === "OPTIONS") {
    const origin = req.get("origin");
    console.log("🔍 [CORS] OPTIONS preflight request:", {
      origin,
      path: req.path,
      normalized: origin ? normalizeOrigin(origin) : null,
      allowed: validateOrigin(origin),
    });

    if (validateOrigin(origin)) {
      // When credentials: true, we must use the specific origin, not "*"
      if (origin) {
        res.header("Access-Control-Allow-Origin", origin);
      }
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS"
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-SSO-Token, X-Community-Token, X-Mobile-App-Id, ngrok-skip-browser-warning"
      );
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Max-Age", "86400");
      console.log("✅ [CORS] OPTIONS preflight allowed for:", origin);
      return res.status(204).end();
    }

    console.log("❌ [CORS] OPTIONS preflight blocked for:", origin);
    return res.status(403).json({ error: "Not allowed by CORS" });
  }
  next();
});

// CORS middleware with explicit header setting for Vercel compatibility
// This ensures headers are set on all responses, not just preflight
app.use((req, res, next) => {
  const origin = req.get("origin");

  if (validateOrigin(origin)) {
    // When credentials: true, we must use the specific origin, not "*"
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-SSO-Token, X-Community-Token, X-Mobile-App-Id, ngrok-skip-browser-warning"
    );
    res.header(
      "Access-Control-Expose-Headers",
      "X-SSO-Token, X-Community-Token"
    );
  }

  next();
});

// Also use cors middleware for additional compatibility
app.use(
  cors({
    origin: (origin, callback) => {
      if (validateOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-SSO-Token",
      "X-Community-Token",
      "X-Mobile-App-Id",
      "ngrok-skip-browser-warning",
    ],
    exposedHeaders: ["X-SSO-Token", "X-Community-Token"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400,
  })
);

// ============================================
// END CORS CONFIGURATION
// ============================================

// Rate limiting for Nominatim API calls
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Max 10 requests per minute per IP

const checkRateLimit = (ip) => {
  if (process.env.DISABLE_RATE_LIMITING === "true" || isDevelopment) {
    return true;
  }
  const now = Date.now();
  const userRequests = rateLimitMap.get(ip) || [];

  // Remove old requests outside the window
  const recentRequests = userRequests.filter(
    (time) => now - time < RATE_LIMIT_WINDOW
  );

  if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    return false; // Rate limit exceeded
  }

  // Add current request
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);

  return true; // Request allowed
};

// upload is already imported from fileValidator middleware

// SECURITY FIX: Mobile app authentication middleware
const validateMobileApp = (req, res, next) => {
  const origin = req.get("origin");

  // If no origin (mobile apps, curl, Postman), validate mobile app ID
  if (!origin) {
    const mobileAppId = req.get("x-mobile-app-id");
    const expectedMobileSecret =
      process.env.MOBILE_APP_SECRET || "gametribe-mobile-2025";

    // Always allow in development/testing mode
    if (process.env.NODE_ENV !== "production") {
      return next();
    }

    if (mobileAppId !== expectedMobileSecret) {
      return res.status(403).json({
        error: "Mobile app authentication required",
        message: "Please use the official GameTribe mobile app",
      });
    }
  }

  next();
};

// Apply mobile app validation (disabled for easier testing)
// Enable this in production by setting NODE_ENV=production and uncommenting below
// if (process.env.NODE_ENV === "production") {
//   app.use(validateMobileApp);
// }

// Apply general rate limiting (noLimiter for development, devLimiter for production)
const isDevelopment =
  process.env.NODE_ENV === "development" ||
  process.env.NODE_ENV !== "production";
const generalRateLimiter = isDevelopment ? noLimiter : devLimiter;

console.log(
  `🔧 Rate limiting mode: ${
    isDevelopment ? "DISABLED (development)" : "ENABLED (production)"
  }`
);
app.use(generalRateLimiter);

// Define Stripe webhook route FIRST with raw parser
// Stripe webhook route FIRST
app.post(
  "/api/payments/stripe/webhook",
  isDevelopment ? noLimiter : webhookLimiter,
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    console.log("🚀 Stripe webhook route hit");
    console.log("📋 Request headers:", req.headers);
    console.log("📦 Body type:", typeof req.body);
    console.log("📦 Body length:", req.body?.length || 0);
    console.log(
      "📦 Body hex preview:",
      req.body?.toString("hex").substring(0, 200) + "..."
    );
    next();
  },
  stripeWebhook
);

// Test webhook endpoint
app.post("/api/payments/stripe/test-webhook", (req, res) => {
  console.log("🧪 Test webhook endpoint hit");
  console.log("📋 Headers:", req.headers);
  console.log("📦 Body:", req.body);
  res.json({
    message: "Test webhook received",
    timestamp: new Date().toISOString(),
  });
});

// Apply global middleware AFTER webhook
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Determine route prefix based on environment
// Firebase Functions URL is already /api, so we don't add /api prefix
// For local development, we need /api prefix
const isFirebaseFunctions = !!(
  process.env.FUNCTION_NAME || process.env.FIREBASE_CONFIG
);
const routePrefix = isFirebaseFunctions ? "" : "/api";

console.log(
  `🔧 Route prefix: "${routePrefix}" (Firebase Functions: ${isFirebaseFunctions})`
);

// Mount routes with conditional rate limiting
app.use(`${routePrefix}/posts`, postsRouter);
app.use(`${routePrefix}/clans`, clansRouter);
app.use(`${routePrefix}/users`, usersRouter);
app.use(`${routePrefix}/events`, eventsRouter);
app.use(
  `${routePrefix}/payments`,
  isDevelopment ? noLimiter : paymentLimiter,
  paymentRouter
);
app.use(`${routePrefix}/leaderboard`, leaderboardRouter);
app.use(`${routePrefix}/contact`, contactRouter);

// ✅ NEW: Mount production-grade routes with conditional rate limiting
app.use(`${routePrefix}/analytics`, analyticsRouter);
app.use(
  `${routePrefix}/search`,
  isDevelopment ? noLimiter : searchLimiter,
  searchRouter
);
app.use(`${routePrefix}/game-scores`, gameScoresRouter);
app.use(`${routePrefix}/game-reviews`, gameReviewsRouter);
app.use(`${routePrefix}/games`, gamesRouter);
app.use(`${routePrefix}/challenges`, challengeRouter);
app.use(`${routePrefix}/notifications`, notificationRouter);
app.use(`${routePrefix}/wallet`, walletRouter);
app.use(`${routePrefix}/admin`, adminRouter);
app.use(`${routePrefix}/messages`, messagesRouter);
app.use(`${routePrefix}/migration`, migrationRouter);

// Add auth route for cross-platform authentication with conditional rate limiting
app.use(
  `${routePrefix}/auth`,
  isDevelopment ? noLimiter : authLimiter,
  require("./routes/auth")
);

// Open Graph unfurl endpoint using proper scraper with new middleware
app.get(
  `${routePrefix}/og`,
  isDevelopment ? noLimiter : searchLimiter,
  rateLimitOgRequests,
  validateUrlMiddleware,
  async (req, res) => {
    try {
      const targetUrl = req.validatedUrl;

      // Check cache first
      const cached = getCachedOgData(targetUrl);
      if (cached) {
        return res.json({
          ...cached,
          cached: true,
        });
      }

      const ogScraper = require("./utils/ogScraper");

      // Cache the result
      setCachedOgData(targetUrl, data);

      res.json({
        ...data,
        cached: false,
      });
    } catch (e) {
      console.error("/api/og error", e.message);

      // Handle specific error types more gracefully
      if (
        e.message.includes("503") ||
        e.message.includes("Service Unavailable")
      ) {
        res.status(503).json({
          error: "Website temporarily unavailable",
          details:
            "The target website is currently unavailable. Please try again later.",
        });
      } else if (e.message.includes("404") || e.message.includes("Not Found")) {
        res.status(404).json({
          error: "Page not found",
          details: "The requested page could not be found.",
        });
      } else if (e.message.includes("403") || e.message.includes("Forbidden")) {
        res.status(403).json({
          error: "Access denied",
          details: "Access to this website is forbidden.",
        });
      } else {
        res
          .status(500)
          .json({ error: "Failed to unfurl url", details: e.message });
      }
    }
  }
);

// OpenStreetMap Nominatim API endpoint (Free alternative to Google Places)
app.get(
  "/api/places/search",
  isDevelopment ? noLimiter : searchLimiter,
  async (req, res) => {
    try {
      const { query, lat, lng } = req.query;
      const clientIP = req.ip || req.connection.remoteAddress || "unknown";

      // Check rate limit
      if (!checkRateLimit(clientIP)) {
        return res.status(429).json({
          error: "Rate limit exceeded",
          message:
            "Too many requests. Please wait a moment before searching again.",
        });
      }

      if (!query || query.length < 3) {
        console.log("Query validation failed:", {
          query,
          length: query?.length,
        });
        return res
          .status(400)
          .json({ error: "Query must be at least 3 characters long" });
      }

      console.log("Places search request:", {
        query,
        lat,
        lng,
        queryLength: query.length,
        clientIP,
      });

      // Build Nominatim API URL with optional location bias
      let apiUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        query
      )}&limit=5&addressdetails=1&extratags=1`;

      // Add location bias if coordinates are provided (prioritize nearby results)
      if (lat && lng) {
        // Use viewbox for location bias but don't restrict results to only within the box
        const latOffset = 0.5; // ~55km radius
        const lngOffset = 0.5; // ~55km radius
        const minLon = parseFloat(lng) - lngOffset;
        const minLat = parseFloat(lat) - latOffset;
        const maxLon = parseFloat(lng) + lngOffset;
        const maxLat = parseFloat(lat) + latOffset;
        const viewbox = `${minLon},${minLat},${maxLon},${maxLat}`;
        apiUrl += `&viewbox=${viewbox}`; // No bounded=1 to allow results outside the box
      }

      // Debug: Log the API URL being called
      console.log("Nominatim API URL:", apiUrl);

      // Add a small delay to be respectful to Nominatim API
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Use OpenStreetMap Nominatim API (completely free, no billing required)
      // Add proper headers to comply with Nominatim usage policy
      const response = await fetch(apiUrl, {
        headers: {
          "User-Agent":
            "GameTribe-Community/1.0 (https://gametribe-backend.onrender.com)",
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        console.error(
          "Nominatim API error:",
          response.status,
          response.statusText
        );
        const errorText = await response.text();
        console.error("Nominatim API error response:", errorText);

        // If we get a 403 (blocked), provide a fallback response
        if (response.status === 403) {
          console.log("Nominatim API blocked, providing fallback suggestions");
          return res.json({
            suggestions: [
              {
                id: "fallback-1",
                name: query,
                address: `${query}, Kenya`,
                location: {
                  lat: lat ? parseFloat(lat) : -1.1544312,
                  lng: lng ? parseFloat(lng) : 36.9650841,
                },
              },
            ],
          });
        }

        throw new Error(
          `Nominatim API error: ${response.status} - ${errorText}`
        );
      }

      const data = await response.json();

      if (data && data.length > 0) {
        let suggestions = data.map((place) => ({
          id: place.place_id || place.osm_id,
          name: place.display_name.split(",")[0] || place.name || "Unknown",
          address: place.display_name,
          location: {
            lat: parseFloat(place.lat),
            lng: parseFloat(place.lon),
          },
        }));

        // Sort by distance if user location is provided
        if (lat && lng) {
          const userLat = parseFloat(lat);
          const userLng = parseFloat(lng);

          // Calculate distance using Haversine formula
          const calculateDistance = (lat1, lon1, lat2, lon2) => {
            const R = 6371; // Earth's radius in kilometers
            const dLat = ((lat2 - lat1) * Math.PI) / 180;
            const dLon = ((lon2 - lon1) * Math.PI) / 180;
            const a =
              Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos((lat1 * Math.PI) / 180) *
                Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) *
                Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c; // Distance in kilometers
          };

          // Add distance to each suggestion and sort by distance
          suggestions = suggestions
            .map((suggestion) => ({
              ...suggestion,
              distance: calculateDistance(
                userLat,
                userLng,
                suggestion.location.lat,
                suggestion.location.lng
              ),
            }))
            .sort((a, b) => a.distance - b.distance);

          // Debug: Log sorted suggestions with distances
          console.log(
            "Sorted suggestions by distance:",
            suggestions.map((s) => ({
              name: s.name,
              address: s.address,
              distance: `${s.distance.toFixed(2)}km`,
            }))
          );

          // Remove distance from final response (keep it internal)
          suggestions = suggestions.map(
            ({ distance, ...suggestion }) => suggestion
          );
        }

        res.json({ suggestions });
      } else {
        res.status(400).json({
          error: "No results found",
          message: "No places found for the given query",
        });
      }
    } catch (error) {
      console.error("Nominatim API error:", error);
      res.status(500).json({
        error: "Failed to search places",
        details: error.message,
      });
    }
  }
);

app.get(`${routePrefix}/test`, (req, res) => {
  res.json({
    message: "API is working",
    environment: process.env.NODE_ENV,
    isFirebaseFunctions: !!isFirebaseFunctions,
  });
});

// Admin/Firebase health endpoint
app.get(`${routePrefix}/health/admin`, (req, res) => {
  try {
    const { getAdminHealth } = require("./config/firebase");
    const health = getAdminHealth && getAdminHealth();
    res.json({
      healthy: !!health?.healthy,
      lastCheck: health?.lastCheck
        ? new Date(health.lastCheck).toISOString()
        : null,
      lastError: health?.lastError || null,
    });
  } catch (e) {
    res.status(500).json({ healthy: false, error: e.message });
  }
});

// Test Firebase connection
app.get(`${routePrefix}/test-firebase`, async (req, res) => {
  try {
    const { database } = require("./config/firebase");
    const testRef = database.ref("test");
    await testRef.set({ timestamp: new Date().toISOString() });
    const snapshot = await testRef.once("value");
    await testRef.remove();
    res.json({ message: "Firebase connection working", data: snapshot.val() });
  } catch (error) {
    console.error("Firebase test error:", error);
    res
      .status(500)
      .json({ error: "Firebase connection failed", details: error.message });
  }
});

// Import error handler
const { errorHandler } = require("./middleware/errorHandler");

// Global error handler (SECURITY FIX: Sanitized errors)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: "File upload error",
      message:
        process.env.NODE_ENV === "development"
          ? err.message
          : "Invalid file upload",
    });
  }
  if (err.message === "Unexpected end of form") {
    return res.status(400).json({
      error: "Invalid request",
      message: "Malformed request data",
    });
  }

  // Use sanitized error handler
  errorHandler(err, req, res, next);
});

// Add file validation error handler
app.use(handleFileValidationError);

// Use PORT from environment (Vercel sets this) or default to 5000
const PORT = process.env.PORT || 5000;

// Import challenge cleanup service
const { startCleanupSchedule } = require("./services/challengeCleanup");

// Start server (for local development or non-Firebase deployments)
const startServer = async () => {
  try {
    // Start HTTP server
    const httpServer = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🗄️ Database: Firebase (default)`);
      console.log(`💾 Cache: In-memory (efficient)`);
      console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);

      // Start challenge cleanup schedule
      startCleanupSchedule();
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

// Export for Vercel, Firebase Functions, or start local server
// isFirebaseFunctions is already defined earlier in the file
if (process.env.VERCEL) {
  // Vercel serverless environment
  // Note: Socket.IO doesn't work on Vercel serverless (neither WebSockets nor polling)
  // because serverless functions are stateless and isolated
  // REST API endpoints work fine, but real-time Socket.IO features are disabled
  // For real-time features, use Firebase Realtime Database listeners or deploy Socket.IO on a persistent server
  module.exports = app;
  console.log("✅ Backend configured for Vercel (serverless)");
  console.log(
    "⚠️ Socket.IO disabled - REST API only. Real-time requires persistent server."
  );
} else if (isFirebaseFunctions) {
  // Firebase Functions environment
  const functions = require("firebase-functions/v2");

  // Export the Express app as a Firebase Function
  // Using v2 API with options
  exports.api = functions.https.onRequest(
    {
      timeoutSeconds: 300,
      memory: "512MiB",
    },
    app
  );

  console.log("✅ Backend configured for Firebase Functions v2");
} else {
  // Local development or other hosting platforms
  startServer();
}
