const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/auth");
const searchService = require("../services/search");
const { generalLimiter } = require("../middleware/rateLimiter");

// ✅ NEW: Advanced search routes

// Main search endpoint
router.get("/", authenticate, generalLimiter, async (req, res) => {
  try {
    const { 
      q: query, 
      type = 'all', 
      page = 1, 
      limit = 20, 
      sortBy = 'relevance',
      category,
      authorId,
      dateFrom,
      dateTo,
      hasImage,
      isRepost
    } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: "Search query must be at least 2 characters long"
      });
    }

    const searchOptions = {
      type,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100), // Max 100 results
      sortBy,
      filters: {
        category,
        authorId,
        dateFrom,
        dateTo,
        hasImage: hasImage === 'true',
        isRepost: isRepost === 'true'
      }
    };

    const results = await searchService.search(query, searchOptions);
    
    res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({
      success: false,
      error: "Search failed"
    });
  }
});

// Search suggestions
router.get("/suggestions", authenticate, generalLimiter, async (req, res) => {
  try {
    const { q: query, limit = 5 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }

    const suggestions = await searchService.getSearchSuggestions(query, parseInt(limit));
    
    res.status(200).json({
      success: true,
      data: suggestions
    });
  } catch (error) {
    console.error("Search suggestions error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get search suggestions"
    });
  }
});

// Trending searches
router.get("/trending", authenticate, generalLimiter, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const trending = await searchService.getTrendingSearches(parseInt(limit));
    
    res.status(200).json({
      success: true,
      data: trending
    });
  } catch (error) {
    console.error("Trending searches error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get trending searches"
    });
  }
});

// Search posts only
router.get("/posts", authenticate, generalLimiter, async (req, res) => {
  try {
    const { 
      q: query, 
      page = 1, 
      limit = 20, 
      sortBy = 'relevance',
      category,
      authorId,
      dateFrom,
      dateTo,
      hasImage,
      isRepost
    } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: "Search query must be at least 2 characters long"
      });
    }

    const searchOptions = {
      type: 'posts',
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      sortBy,
      filters: {
        category,
        authorId,
        dateFrom,
        dateTo,
        hasImage: hasImage === 'true',
        isRepost: isRepost === 'true'
      }
    };

    const results = await searchService.search(query, searchOptions);
    
    res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("Search posts error:", error);
    res.status(500).json({
      success: false,
      error: "Search posts failed"
    });
  }
});

// Search users only
router.get("/users", authenticate, generalLimiter, async (req, res) => {
  try {
    const { 
      q: query, 
      page = 1, 
      limit = 20, 
      sortBy = 'relevance',
      isActive
    } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: "Search query must be at least 2 characters long"
      });
    }

    const searchOptions = {
      type: 'users',
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      sortBy,
      filters: {
        isActive: isActive === 'true'
      }
    };

    const searchResults = await searchService.search(query, searchOptions);
    
    // Return the users array directly for easier consumption
    const users = searchResults.results || searchResults || [];
    
    // Log for debugging
    console.log(`🔍 [Search API] Query: "${query}", Found ${users.length} users`);
    if (users.length > 0) {
      console.log(`🔍 [Search API] Sample results:`, users.slice(0, 3).map(u => ({
        uid: u.uid,
        displayName: u.displayName || u.name,
        username: u.username,
        email: u.email
      })));
    } else {
      console.log(`🔍 [Search API] No users found for query: "${query}"`);
    }
    
    res.status(200).json({
      success: true,
      data: users  // Return array directly, not the whole searchResults object
    });
  } catch (error) {
    console.error("Search users error:", error);
    res.status(500).json({
      success: false,
      error: "Search users failed"
    });
  }
});

// Search comments only
router.get("/comments", authenticate, generalLimiter, async (req, res) => {
  try {
    const { 
      q: query, 
      page = 1, 
      limit = 20, 
      sortBy = 'relevance',
      postId,
      authorId
    } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: "Search query must be at least 2 characters long"
      });
    }

    const searchOptions = {
      type: 'comments',
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      sortBy,
      filters: {
        postId,
        authorId
      }
    };

    const results = await searchService.search(query, searchOptions);
    
    res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("Search comments error:", error);
    res.status(500).json({
      success: false,
      error: "Search comments failed"
    });
  }
});

// Build search index (admin only)
router.post("/build-index", authenticate, generalLimiter, async (req, res) => {
  try {
    // This would typically require admin permissions
    const result = await searchService.buildSearchIndex();
    
    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Build search index error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to build search index"
    });
  }
});

module.exports = router;