const { database, storage } = require("../config/firebase");
const { v4: uuidv4 } = require("uuid");
const sanitizeHtml = require("sanitize-html");
const emailService = require("../services/emailService");

// Sanitize HTML input
const sanitizeInput = (html) => {
  return sanitizeHtml(html, {
    allowedTags: ["p", "b", "i", "em", "strong", "a", "ul", "ol", "li", "br"],
    allowedAttributes: {
      a: ["href", "target"],
    },
  });
};

const createEvent = async (req, res, next) => {
  try {
    console.log("📝 Create Event - Request body:", req.body);
    console.log("📝 Create Event - User:", req.user?.uid);
    console.log("📝 Create Event - File:", req.file ? "Present" : "None");

    const {
      title,
      description,
      startDate,
      endDate,
      imageUrl,
      category,
      maxAttendees,
      meetingType,
      location,
      locationCoords,
      locationName,
      locationAddress,
      meetingLink,
    } = req.body;
    const userId = req.user.uid;

    if (!title || !description || !startDate) {
      console.log("❌ Create Event - Missing required fields:", {
        title: !!title,
        description: !!description,
        startDate: !!startDate,
      });
      return res
        .status(400)
        .json({ error: "Title, description, and start date are required" });
    }

    // Get user information to include author details
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    const userData = userSnapshot.val();

    if (!userData) {
      return res.status(404).json({ error: "User not found" });
    }

    const eventData = {
      title,
      description: sanitizeInput(description),
      startDate,
      endDate: endDate || null,
      image: imageUrl || null,
      category: category || null,
      maxAttendees: maxAttendees ? parseInt(maxAttendees) : null,
      meetingType: meetingType || "physical",
      authorId: userId,
      author:
        userData.username || userData.email?.split("@")[0] || "Unknown User",
      authorImage: userData.avatar || "",
      createdAt: new Date().toISOString(),
      bookings: {},
      comments: 0,
      likes: 0,
      likedBy: [],
    };

    // Add location data for physical events
    if (meetingType === "physical" && location) {
      eventData.location = location;
      if (locationCoords) {
        try {
          eventData.locationCoords = JSON.parse(locationCoords);
        } catch (e) {
          console.error("Error parsing locationCoords:", e);
        }
      }
      if (locationName) {
        eventData.locationName = locationName;
      }
      if (locationAddress) {
        eventData.locationAddress = locationAddress;
      }
    } else if (meetingType === "virtual" && meetingLink) {
      eventData.meetingLink = meetingLink;
    }

    if (req.file) {
      const fileName = `events/${Date.now()}_${req.file.originalname}`;
      // Use unified storage upload utility exposed via storage.uploadFile
      const uploaded = await storage.uploadFile(
        {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname,
        },
        fileName
      );
      if (uploaded && uploaded.url) {
        eventData.image = uploaded.url;
      } else if (uploaded && typeof uploaded.getSignedUrl === "function") {
        const [signedUrl] = await uploaded.getSignedUrl({
          action: "read",
          expires: "03-01-2500",
        });
        eventData.image = signedUrl;
      }
    }

    const eventsRef = database.ref("events");
    const newEventRef = eventsRef.push();
    await newEventRef.set(eventData);

    console.log(
      `✅ Event created successfully - ID: ${newEventRef.key}, Title: "${eventData.title}", Start: ${eventData.startDate}`
    );

    res.status(201).json({ id: newEventRef.key, ...eventData });
  } catch (error) {
    console.error("Error in createEvent:", error.message, error.stack);
    next(error);
  }
};

const getEvents = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    console.log(
      `📄 Fetching events - Page: ${pageNum}, Limit: ${limitNum}, Search: "${search}", Sort: ${sortBy} ${sortOrder}`
    );

    // Use Firebase query for upcoming events to reduce data transfer
    const now = new Date().toISOString();
    const eventsRef = database.ref("events");
    
    // Query upcoming events by startDate
    // Note: This requires an index on startDate in Firebase
    let snapshot;
    try {
      snapshot = await eventsRef
        .orderByChild("startDate")
        .startAt(now)
        .once("value");
    } catch (error) {
      // If index doesn't exist, fallback to fetching all events
      console.warn("Firebase index on startDate not found, falling back to full fetch:", error.message);
      snapshot = await eventsRef.once("value");
    }
    
    const events = snapshot.val() || {};

    let eventsArray = Object.entries(events).map(([id, event]) => {
      const eventStartDate = new Date(event.startDate);
      // Double-check filtering if index was used (Firebase queries are inclusive)
      if (eventStartDate < new Date()) {
        return null;
      }
      return {
        id,
        ...event,
        bookingCount: event.bookings ? Object.keys(event.bookings).length : 0,
      };
    }).filter(Boolean); // Remove null entries from double-check

    console.log(`🕐 Date filtering - Now: ${now}`);
    console.log(`📊 Total upcoming events: ${eventsArray.length}`);

    // Apply search filter
    if (search) {
      eventsArray = eventsArray.filter(
        (event) =>
          event.title.toLowerCase().includes(search.toLowerCase()) ||
          event.description.toLowerCase().includes(search.toLowerCase()) ||
          (event.category &&
            event.category.toLowerCase().includes(search.toLowerCase()))
      );
    }

    // Sort events
    eventsArray.sort((a, b) => {
      let aValue, bValue;

      switch (sortBy) {
        case "startDate":
          aValue = new Date(a.startDate);
          bValue = new Date(b.startDate);
          break;
        case "createdAt":
          aValue = new Date(a.createdAt);
          bValue = new Date(b.createdAt);
          break;
        case "title":
          aValue = a.title.toLowerCase();
          bValue = b.title.toLowerCase();
          break;
        case "bookingCount":
          aValue = a.bookingCount;
          bValue = b.bookingCount;
          break;
        default:
          aValue = new Date(a.startDate);
          bValue = new Date(b.startDate);
      }

      if (sortOrder === "desc") {
        return bValue > aValue ? 1 : bValue < aValue ? -1 : 0;
      } else {
        return aValue > bValue ? 1 : aValue < bValue ? -1 : 0;
      }
    });

    // Apply pagination
    const totalEvents = eventsArray.length;
    const totalPages = Math.ceil(totalEvents / limitNum);
    const paginatedEvents = eventsArray.slice(offset, offset + limitNum);

    console.log(
      `✅ Events fetched - Total: ${totalEvents}, Page: ${pageNum}/${totalPages}, Returned: ${paginatedEvents.length}`
    );

    res.status(200).json({
      events: paginatedEvents,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalEvents,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
        limit: limitNum,
      },
    });
  } catch (error) {
    console.error("Error fetching events:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch events" });
  }
};

const getEventById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const snapshot = await database.ref(`events/${id}`).once("value");
    const event = snapshot.val();
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.status(200).json({
      id,
      ...event,
      bookingCount: event.bookings ? Object.keys(event.bookings).length : 0,
    });
  } catch (error) {
    console.error("Error fetching event:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch event" });
  }
};

const updateEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      startDate,
      endDate,
      imageUrl,
      category,
      maxAttendees,
      meetingType,
      location,
      locationCoords,
      locationName,
      locationAddress,
      meetingLink,
    } = req.body;
    const userId = req.user.uid;

    if (!title || !description || !startDate) {
      return res
        .status(400)
        .json({ error: "Title, description, and start date are required" });
    }

    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : null;
    if (isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid start date" });
    }
    if (end && isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid end date" });
    }
    if (end && end < start) {
      return res
        .status(400)
        .json({ error: "End date must be after start date" });
    }
    if (imageUrl && req.file) {
      return res.status(400).json({
        error: "Please provide either an image file or URL, not both",
      });
    }
    if (req.file && req.file.size > 5 * 1024 * 1024) {
      return res
        .status(400)
        .json({ error: "Image size must be less than 5MB" });
    }

    const eventRef = database.ref(`events/${id}`);
    const snapshot = await eventRef.once("value");
    const event = snapshot.val();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (event.authorId !== userId) {
      return res
        .status(403)
        .json({ error: "Unauthorized: Only the author can update this event" });
    }

    let image = event.image;
    if (req.file) {
      const fileName = `events/${Date.now()}_${req.file.originalname}`;
      const fileRef = storage.bucket().file(fileName);
      await fileRef.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
      });
      const [url] = await fileRef.getSignedUrl({
        action: "read",
        expires: "03-01-2500",
      });
      image = url;
    } else if (imageUrl) {
      image = imageUrl;
    } else if (imageUrl === "") {
      image = null;
    }

    const updates = {};
    if (title) updates.title = title;
    if (description) updates.description = sanitizeInput(description);
    if (startDate) updates.startDate = start.toISOString();
    if (endDate !== undefined) updates.endDate = end ? end.toISOString() : null;
    if (image !== undefined) updates.image = image;
    if (category !== undefined) updates.category = category;
    if (maxAttendees !== undefined)
      updates.maxAttendees = maxAttendees ? parseInt(maxAttendees) : null;
    if (meetingType !== undefined) updates.meetingType = meetingType;
    if (meetingType === "physical") {
      if (location !== undefined) updates.location = location;
      if (locationCoords) {
        try {
          updates.locationCoords = JSON.parse(locationCoords);
        } catch (e) {
          console.error("Error parsing locationCoords:", e);
        }
      }
      if (locationName !== undefined) updates.locationName = locationName;
      if (locationAddress !== undefined)
        updates.locationAddress = locationAddress;
      // Clear virtual meeting fields when switching to physical
      updates.meetingLink = null;
    } else if (meetingType === "virtual") {
      if (meetingLink !== undefined) updates.meetingLink = meetingLink;
      // Clear physical location fields when switching to virtual
      updates.location = null;
      updates.locationCoords = null;
      updates.locationName = null;
      updates.locationAddress = null;
    }

    // Use update() instead of set() to preserve existing data
    await eventRef.update(updates);
    const updatedEvent = { ...event, ...updates };
    res.status(200).json({ id, ...updatedEvent });
  } catch (error) {
    console.error("Error updating event:", error.message, error.stack);
    next(error);
  }
};

const deleteEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.uid;

    const eventRef = database.ref(`events/${id}`);
    const snapshot = await eventRef.once("value");
    const event = snapshot.val();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (event.authorId !== userId) {
      return res
        .status(403)
        .json({ error: "Unauthorized: Only the author can delete this event" });
    }

    if (event.image) {
      try {
        const filePath = event.image.match(/events%2F([^?]+)/)?.[1];
        if (filePath) {
          await storage
            .bucket()
            .file(`events/${decodeURIComponent(filePath)}`)
            .delete();
        }
      } catch (error) {
        console.warn("Error deleting image:", error.message);
      }
    }

    await eventRef.remove();
    res.status(200).json({ message: "Event deleted successfully" });
  } catch (error) {
    console.error("Error deleting event:", error.message, error.stack);
    next(error);
  }
};

const bookEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.uid;

    const eventRef = database.ref(`events/${id}`);
    const snapshot = await eventRef.once("value");
    const event = snapshot.val();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    // Check if event is in the past
    const eventStartDate = new Date(event.startDate);
    const now = new Date();
    if (eventStartDate < now) {
      return res.status(400).json({ error: "Cannot book past events" });
    }

    // Check if event has reached max capacity
    const currentBookings = event.bookings ? Object.keys(event.bookings).length : 0;
    if (event.maxAttendees && currentBookings >= event.maxAttendees) {
      return res
        .status(400)
        .json({ error: "This event has reached its maximum capacity" });
    }

    const bookingRef = database.ref(`events/${id}/bookings/${userId}`);
    const bookingSnapshot = await bookingRef.once("value");
    if (bookingSnapshot.exists()) {
      return res
        .status(400)
        .json({ error: "You have already booked this event" });
    }

    await bookingRef.set({
      bookedAt: new Date().toISOString(),
      userId,
    });

    // Send booking confirmation email
    try {
      await emailService.sendBookingConfirmation(userId, id);
    } catch (emailError) {
      console.error("Failed to send booking confirmation email:", emailError);
      // Don't fail the booking if email fails
    }

    res.status(200).json({ message: "Event booked successfully" });
  } catch (error) {
    console.error("Error booking event:", error.message, error.stack);
    next(error);
  }
};

const cancelBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.uid;

    const bookingRef = database.ref(`events/${id}/bookings/${userId}`);
    const snapshot = await bookingRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Booking not found" });
    }

    await bookingRef.remove();
    res.status(200).json({ message: "Booking cancelled successfully" });
  } catch (error) {
    console.error("Error cancelling booking:", error.message, error.stack);
    next(error);
  }
};

const getEventBookings = async (req, res, next) => {
  try {
    const { id } = req.params;
    const snapshot = await database.ref(`events/${id}/bookings`).once("value");
    const bookings = snapshot.val() || {};

    const bookingsWithUsers = await Promise.all(
      Object.entries(bookings).map(async ([userId, booking]) => {
        const userSnapshot = await database
          .ref(`users/${userId}`)
          .once("value");
        const user = userSnapshot.val() || {};
        return {
          userId,
          bookedAt: booking.bookedAt,
          userName:
            user.displayName || user.email?.split("@")[0] || "Anonymous",
          userAvatar: user.avatar || "https://via.placeholder.com/40",
        };
      })
    );

    res.status(200).json(bookingsWithUsers);
  } catch (error) {
    console.error("Error fetching bookings:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
};

const getUserEventBookings = async (req, res, next) => {
  try {
    const userId = req.user.uid;

    // Get all events created by this user
    const eventsRef = database.ref("events");
    const snapshot = await eventsRef
      .orderByChild("authorId")
      .equalTo(userId)
      .once("value");
    const events = snapshot.val() || {};

    const allBookings = [];

    // For each event, get the bookings
    for (const [eventId, event] of Object.entries(events)) {
      if (event.bookings) {
        const eventBookings = await Promise.all(
          Object.entries(event.bookings).map(async ([bookerId, booking]) => {
            const userSnapshot = await database
              .ref(`users/${bookerId}`)
              .once("value");
            const user = userSnapshot.val() || {};

            return {
              eventId,
              eventTitle: event.title,
              eventDate: event.startDate,
              bookerId,
              bookerName:
                user.displayName || user.email?.split("@")[0] || "Anonymous",
              bookerAvatar: user.avatar || "https://via.placeholder.com/40",
              bookedAt: booking.bookedAt,
            };
          })
        );

        allBookings.push(...eventBookings);
      }
    }

    // Sort by booking date (newest first)
    allBookings.sort((a, b) => new Date(b.bookedAt) - new Date(a.bookedAt));

    res.status(200).json(allBookings);
  } catch (error) {
    console.error(
      "Error fetching user event bookings:",
      error.message,
      error.stack
    );
    res.status(500).json({ error: "Failed to fetch user event bookings" });
  }
};

// Get user's own bookings (events they've booked for)
const getUserBookings = async (req, res, next) => {
  try {
    const userId = req.user.uid;

    // Get all events and find ones where this user has booked
    const eventsRef = database.ref("events");
    const snapshot = await eventsRef.once("value");
    const events = snapshot.val() || {};

    const userBookings = [];

    // For each event, check if the user has booked
    for (const [eventId, event] of Object.entries(events)) {
      if (event.bookings && event.bookings[userId]) {
        const booking = event.bookings[userId];
        const organizerSnapshot = await database
          .ref(`users/${event.authorId}`)
          .once("value");
        const organizer = organizerSnapshot.val() || {};

        userBookings.push({
          eventId,
          eventTitle: event.title,
          eventDate: event.startDate,
          eventDescription: event.description,
          eventImage: event.image,
          organizerId: event.authorId,
          organizerName:
            organizer.displayName ||
            organizer.email?.split("@")[0] ||
            "Event Organizer",
          organizerAvatar: organizer.avatar || "https://via.placeholder.com/40",
          bookedAt: booking.bookedAt,
          bookingStatus: "confirmed",
        });
      }
    }

    // Sort by booking date (newest first)
    userBookings.sort((a, b) => new Date(b.bookedAt) - new Date(a.bookedAt));

    res.status(200).json(userBookings);
  } catch (error) {
    console.error("Error fetching user bookings:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch user bookings" });
  }
};

// Get events created by the current user with all their bookings
const getCreatedEvents = async (req, res, next) => {
  try {
    const userId = req.user.uid;

    // Get all events created by this user
    const eventsRef = database.ref("events");
    const snapshot = await eventsRef.once("value");
    const events = snapshot.val() || {};

    const createdEvents = [];

    // For each event, check if the user is the author
    for (const [eventId, event] of Object.entries(events)) {
      if (event.authorId === userId) {
        const eventBookings = [];

        // Get all bookings for this event
        if (event.bookings) {
          for (const [bookerId, booking] of Object.entries(event.bookings)) {
            const bookerSnapshot = await database
              .ref(`users/${bookerId}`)
              .once("value");
            const booker = bookerSnapshot.val() || {};

            eventBookings.push({
              bookerId,
              bookerName:
                booker.displayName ||
                booker.email?.split("@")[0] ||
                "Anonymous",
              bookerAvatar: booker.avatar || "https://via.placeholder.com/40",
              bookedAt: booking.bookedAt,
              bookingStatus: "confirmed",
            });
          }
        }

        // Sort bookings by date (newest first)
        eventBookings.sort(
          (a, b) => new Date(b.bookedAt) - new Date(a.bookedAt)
        );

        createdEvents.push({
          eventId,
          eventTitle: event.title,
          eventDate: event.startDate,
          eventDescription: event.description,
          eventImage: event.image,
          createdAt: event.createdAt,
          maxAttendees: event.maxAttendees || 0,
          bookings: eventBookings,
        });
      }
    }

    // Sort events by creation date (newest first)
    createdEvents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.status(200).json(createdEvents);
  } catch (error) {
    console.error("Error fetching created events:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch created events" });
  }
};

const contactBooker = async (req, res, next) => {
  try {
    const userId = req.user.uid;
    const { bookerId, eventId, eventTitle, message } = req.body;

    if (!bookerId || !eventId || !eventTitle || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify the event belongs to the user
    const eventRef = database.ref(`events/${eventId}`);
    const eventSnapshot = await eventRef.once("value");
    const event = eventSnapshot.val();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (event.authorId !== userId) {
      return res
        .status(403)
        .json({ error: "You can only contact bookers for your own events" });
    }

    // Verify the booking exists
    const bookingRef = database.ref(`events/${eventId}/bookings/${bookerId}`);
    const bookingSnapshot = await bookingRef.once("value");

    if (!bookingSnapshot.exists()) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Get booker information
    const bookerRef = database.ref(`users/${bookerId}`);
    const bookerSnapshot = await bookerRef.once("value");
    const booker = bookerSnapshot.val() || {};

    // Get sender information
    const senderRef = database.ref(`users/${userId}`);
    const senderSnapshot = await senderRef.once("value");
    const sender = senderSnapshot.val() || {};

    // Store the message in the database for record keeping
    const messageId = uuidv4();
    const messageData = {
      id: messageId,
      fromUserId: userId,
      fromUserName:
        sender.displayName || sender.email?.split("@")[0] || "Event Organizer",
      toUserId: bookerId,
      toUserName:
        booker.displayName || booker.email?.split("@")[0] || "Event Booker",
      eventId,
      eventTitle,
      message: message,
      sentAt: new Date().toISOString(),
      read: false,
    };

    // Store in messages collection
    const messagesRef = database.ref("eventMessages");
    await messagesRef.child(messageId).set(messageData);

    // TODO: In a production environment, you would integrate with an email service here
    // For now, we'll just log the message and return success
    console.log("Event Message:", {
      from: sender.email || userId,
      to: booker.email || bookerId,
      event: eventTitle,
      message: message,
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      message: "Message sent successfully",
      messageId: messageId,
    });
  } catch (error) {
    console.error("Error contacting booker:", error.message, error.stack);
    res.status(500).json({ error: "Failed to send message" });
  }
};

const getEventComments = async (req, res, next) => {
  try {
    const { eventId } = req.params;
    if (!eventId) {
      return res.status(400).json({ error: "Event ID is required" });
    }
    const eventRef = database.ref(`events/${eventId}`);
    const eventSnapshot = await eventRef.once("value");
    if (!eventSnapshot.exists()) {
      return res.status(404).json({ error: "Event not found" });
    }
    const commentsRef = database.ref(`events/${eventId}/comments`);
    const commentsSnapshot = await commentsRef
      .orderByChild("createdAt")
      .once("value");
    const commentsData = commentsSnapshot.val() || {};
    const comments = [];
    for (const [commentId, commentData] of Object.entries(commentsData)) {
      const repliesRef = database.ref(
        `events/${eventId}/comments/${commentId}/replies`
      );
      const repliesSnapshot = await repliesRef
        .orderByChild("createdAt")
        .once("value");
      const repliesData = repliesSnapshot.val() || {};
      commentData.id = commentId;
      commentData.likes = commentData.likes || 0;
      commentData.likedBy = Array.isArray(commentData.likedBy)
        ? commentData.likedBy
        : [];
      commentData.replies = Object.entries(repliesData).map(
        ([replyId, replyData]) => ({
          id: replyId,
          ...replyData,
          likes: replyData.likes || 0,
          likedBy: Array.isArray(replyData.likedBy) ? replyData.likedBy : [],
        })
      );
      comments.push(commentData);
    }
    comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.status(200).json(comments);
  } catch (error) {
    console.error("Error fetching event comments:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
};

const createEventComment = async (req, res, next) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.uid;
    if (!eventId) {
      return res.status(400).json({ error: "Event ID is required" });
    }
    if (!req.body.content && !req.file) {
      return res
        .status(400)
        .json({ error: "Comment content or attachment is required" });
    }
    const sanitizedContent = sanitizeInput(req.body.content) || "";
    const eventRef = database.ref(`events/${eventId}`);
    const eventSnapshot = await eventRef.once("value");
    if (!eventSnapshot.exists()) {
      return res.status(404).json({ error: "Event not found" });
    }
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const userData = userSnapshot.val();
    let attachmentUrl = "";
    if (req.file) {
      const file = req.file;
      if (!file.mimetype.startsWith("image/")) {
        return res.status(400).json({ error: "Only image files are allowed" });
      }
      const fileName = `events/${eventId}/comments/${Date.now()}-${
        file.originalname
      }`;
      const fileRef = storage.bucket().file(fileName);
      await fileRef.save(file.buffer, { contentType: file.mimetype });
      [attachmentUrl] = await fileRef.getSignedUrl({
        action: "read",
        expires: "03-01-2500",
      });
    }
    const commentId = uuidv4();
    const comment = {
      id: commentId,
      eventId,
      authorId: userId,
      author: userData.username || userData.email.split("@")[0],
      authorImage: userData.avatar || "",
      content: sanitizedContent,
      attachment: attachmentUrl,
      likes: 0,
      likedBy: [],
      createdAt: new Date().toISOString(),
    };
    await database.ref(`events/${eventId}/comments/${commentId}`).set(comment);
    await eventRef.update({
      comments: (eventSnapshot.val().comments || 0) + 1,
    });
    res.status(201).json(comment);
  } catch (error) {
    console.error("Error creating event comment:", error.message, error.stack);
    res.status(500).json({ error: "Failed to create comment" });
  }
};

const createEventReply = async (req, res, next) => {
  try {
    const { eventId, commentId } = req.params;
    const userId = req.user.uid;
    if (!eventId || !commentId) {
      return res
        .status(400)
        .json({ error: "Event ID and Comment ID are required" });
    }
    if (!req.body.content && !req.file) {
      return res
        .status(400)
        .json({ error: "Reply content or attachment is required" });
    }
    const sanitizedContent = sanitizeInput(req.body.content) || "";
    const eventRef = database.ref(`events/${eventId}`);
    const eventSnapshot = await eventRef.once("value");
    if (!eventSnapshot.exists()) {
      return res.status(404).json({ error: "Event not found" });
    }
    const commentRef = database.ref(`events/${eventId}/comments/${commentId}`);
    const commentSnapshot = await commentRef.once("value");
    if (!commentSnapshot.exists()) {
      return res.status(404).json({ error: "Comment not found" });
    }
    const userRef = database.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }
    const userData = userSnapshot.val();
    let attachmentUrl = "";
    if (req.file) {
      const file = req.file;
      if (!file.mimetype.startsWith("image/")) {
        return res.status(400).json({ error: "Only image files are allowed" });
      }
      const fileName = `events/${eventId}/comments/${commentId}/replies/${Date.now()}-${
        file.originalname
      }`;
      const fileRef = storage.bucket().file(fileName);
      await fileRef.save(file.buffer, { contentType: file.mimetype });
      [attachmentUrl] = await fileRef.getSignedUrl({
        action: "read",
        expires: "03-01-2500",
      });
    }
    const replyId = uuidv4();
    const reply = {
      id: replyId,
      eventId,
      commentId,
      authorId: userId,
      author: userData.username || userData.email.split("@")[0],
      authorImage: userData.avatar || "",
      content: sanitizedContent,
      attachment: attachmentUrl,
      likes: 0,
      likedBy: [],
      createdAt: new Date().toISOString(),
    };
    await database
      .ref(`events/${eventId}/comments/${commentId}/replies/${replyId}`)
      .set(reply);
    res.status(201).json(reply);
  } catch (error) {
    console.error("Error creating event reply:", error.message, error.stack);
    res.status(500).json({ error: "Failed to create reply" });
  }
};

const likeEventComment = async (req, res, next) => {
  try {
    const { eventId, commentId } = req.params;
    const userId = req.user.uid;
    if (!eventId || !commentId) {
      return res
        .status(400)
        .json({ error: "Event ID and Comment ID are required" });
    }
    const commentRef = database.ref(`events/${eventId}/comments/${commentId}`);
    const commentSnapshot = await commentRef.once("value");
    if (!commentSnapshot.exists()) {
      return res.status(404).json({ error: "Comment not found" });
    }
    const commentData = commentSnapshot.val();
    let likes = commentData.likes || 0;
    let likedBy = Array.isArray(commentData.likedBy) ? commentData.likedBy : [];
    if (likedBy.includes(userId)) {
      likes = Math.max(likes - 1, 0);
      likedBy = likedBy.filter((uid) => uid !== userId);
    } else {
      likes += 1;
      likedBy.push(userId);
    }
    await commentRef.update({ likes, likedBy });
    res.status(200).json({ message: "Comment like updated", likes, likedBy });
  } catch (error) {
    console.error("Error liking event comment:", error.message, error.stack);
    res.status(500).json({ error: "Failed to update comment like" });
  }
};

const likeEventReply = async (req, res, next) => {
  try {
    const { eventId, commentId, replyId } = req.params;
    const userId = req.user.uid;
    if (!eventId || !commentId || !replyId) {
      return res
        .status(400)
        .json({ error: "Event ID, Comment ID, and Reply ID are required" });
    }
    const replyRef = database.ref(
      `events/${eventId}/comments/${commentId}/replies/${replyId}`
    );
    const replySnapshot = await replyRef.once("value");
    if (!replySnapshot.exists()) {
      return res.status(404).json({ error: "Reply not found" });
    }
    const replyData = replySnapshot.val();
    let likes = replyData.likes || 0;
    let likedBy = Array.isArray(replyData.likedBy) ? replyData.likedBy : [];
    if (likedBy.includes(userId)) {
      likes = Math.max(likes - 1, 0);
      likedBy = likedBy.filter((uid) => uid !== userId);
    } else {
      likes += 1;
      likedBy.push(userId);
    }
    await replyRef.update({ likes, likedBy });
    res.status(200).json({ message: "Reply like updated", likes, likedBy });
  } catch (error) {
    console.error("Error liking event reply:", error.message, error.stack);
    res.status(500).json({ error: "Failed to update reply like" });
  }
};

const likeEvent = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.uid;

    const eventRef = database.ref(`events/${id}`);
    const eventSnapshot = await eventRef.once("value");
    const event = eventSnapshot.val();

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const likedBy = event.likedBy || [];
    const isLiked = likedBy.includes(userId);

    if (isLiked) {
      // Unlike
      const updatedLikedBy = likedBy.filter((uid) => uid !== userId);
      await eventRef.update({
        likes: Math.max(0, (event.likes || 0) - 1),
        likedBy: updatedLikedBy,
      });
      res
        .status(200)
        .json({ liked: false, likes: Math.max(0, (event.likes || 0) - 1) });
    } else {
      // Like
      const updatedLikedBy = [...likedBy, userId];
      await eventRef.update({
        likes: (event.likes || 0) + 1,
        likedBy: updatedLikedBy,
      });
      res.status(200).json({ liked: true, likes: (event.likes || 0) + 1 });
    }
  } catch (error) {
    console.error("Error liking event:", error.message, error.stack);
    res.status(500).json({ error: "Failed to like event" });
  }
};

module.exports = {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  bookEvent,
  cancelBooking,
  getEventBookings,
  getUserEventBookings,
  getUserBookings,
  getCreatedEvents,
  contactBooker,
  getEventComments,
  createEventComment,
  createEventReply,
  likeEventComment,
  likeEventReply,
  likeEvent,
};
