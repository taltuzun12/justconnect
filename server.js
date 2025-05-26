const WebSocket = require('ws'); // Import the WebSocket library
const { v4: uuidv4 } = require('uuid'); // For generating unique user IDs

// Render.com and similar platforms provide the PORT environment variable.
// Use 8080 as default for local development.
const PORT = process.env.PORT || 8080;

// Initialize the WebSocket server on the specified port
const wss = new WebSocket.Server({ port: PORT });

// Store connected clients and their associated WebSocket objects and preferences.
// Key: userId, Value: { ws: WebSocket instance, gender: string, lookingFor: string, searchTimeout: NodeJS.Timeout | null }
const connectedClients = new Map();

// Queue for users waiting to be paired.
// Each item in the queue will be an object: { userId: string, gender: string, lookingFor: string }
const waitingQueue = [];

// Store active chat pairs.
// Key: userId, Value: partnerId
const activePairs = new Map();

// --- Rate Limiting Logic ---
// Store request counts for each IP address
// Key: IP_Address, Value: { count: number, lastReset: number }
const ipRequestCounts = new Map();

// Rate limiting constants
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const MAX_REQUESTS_PER_WINDOW = 5; // Max 5 requests per IP in the window for 'findPartner'

console.log(`WebSocket server is running on port ${PORT}.`);

// Periodically clean up old IP request counts from the map
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of ipRequestCounts.entries()) {
        if (now - data.lastReset > RATE_LIMIT_WINDOW_MS * 2) { // Clear entries older than twice the window
            ipRequestCounts.delete(ip);
            console.log(`Old IP request count for ${ip} cleared.`);
        }
    }
}, RATE_LIMIT_WINDOW_MS); // Clean up every window duration

/**
 * Checks if two users can be matched based on their gender and lookingFor preferences.
 * A match occurs if user1 prefers user2's gender AND user2 prefers user1's gender.
 * 'Any' preference means the user is open to any gender.
 * @param {object} user1 - The first user object { userId, gender, lookingFor }.
 * @param {object} user2 - The second user object { userId, gender, lookingFor }.
 * @returns {boolean} True if they can be matched, false otherwise.
 */
function canMatch(user1, user2) {
    // Check if user1's preference matches user2's gender
    const user1PrefersUser2 = user1.lookingFor === 'Any' || user1.lookingFor === user2.gender;
    // Check if user2's preference matches user1's gender
    const user2PrefersUser1 = user2.lookingFor === 'Any' || user2.lookingFor === user1.gender;

    // Both preferences must be satisfied for a match
    return user1PrefersUser2 && user2PrefersUser1;
}

/**
 * Handles the disconnection or leaving of a user, cleaning up their state
 * and notifying their partner if they were in a chat.
 * @param {string} disconnectedUserId The ID of the user who disconnected or left.
 * @param {boolean} isSkipping Whether the user is skipping (true) or fully disconnecting/leaving chat (false).
 */
function handleUserDisconnection(disconnectedUserId, isSkipping = false) {
    // Remove the user from the waiting queue if they are currently in it.
    const waitingIndex = waitingQueue.findIndex(user => user.userId === disconnectedUserId);
    if (waitingIndex > -1) {
        waitingQueue.splice(waitingIndex, 1);
        console.log(`${disconnectedUserId} removed from waiting queue.`);
    }

    // Clear any pending search timeout for this user.
    const clientInfo = connectedClients.get(disconnectedUserId);
    if (clientInfo && clientInfo.searchTimeout) {
        clearTimeout(clientInfo.searchTimeout);
        clientInfo.searchTimeout = null;
        console.log(`Search timeout cleared for user ${disconnectedUserId}.`);
    }

    // Check if the disconnected user was part of an active chat pair.
    const partnerId = activePairs.get(disconnectedUserId);
    if (partnerId) {
        // If a partner exists, remove both sides of the pairing from activePairs.
        activePairs.delete(disconnectedUserId);
        activePairs.delete(partnerId);

        // Attempt to get the WebSocket object for the partner.
        const partnerWs = connectedClients.get(partnerId)?.ws;
        // If the partner's WebSocket is still open, notify them that their partner has left.
        if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
            partnerWs.send(JSON.stringify({ type: 'userLeft', userId: disconnectedUserId }));
            console.log(`Notified ${partnerId} that ${disconnectedUserId} has left the chat.`);
        } else {
            // Log if the partner was already disconnected or not found.
            console.log(`Partner ${partnerId} of ${disconnectedUserId} was already disconnected or not found.`);
        }
    }

    // If the user is not just skipping (i.e., they are fully disconnecting),
    // remove their entry from the connectedClients map.
    // If they are skipping, their WebSocket object is retained as they will immediately
    // send a new 'findPartner' request.
    if (!isSkipping) {
        connectedClients.delete(disconnectedUserId);
        console.log(`${disconnectedUserId} removed from connected clients.`);
        // After a user fully disconnects, update all remaining clients with the new active user count.
        broadcastActiveUserCount();
    } else {
        console.log(`${disconnectedUserId} is skipping and will re-request a partner.`);
    }
}

/**
 * Attempts to find a match among users in the waiting queue and notifies partners if a match is found.
 * @param {WebSocket} ws The WebSocket object of the current user.
 * @param {string} userId The ID of the current user.
 * @param {string} gender The gender of the current user.
 * @param {string} lookingFor The preference of who the current user is looking for.
 */
function findAndMatchPartner(ws, userId, gender, lookingFor) {
    const clientInfo = connectedClients.get(userId);
    let partnerFound = false;

    // Iterate through the waiting queue to find a suitable partner.
    // Iterate backwards to safely remove elements if a match is found.
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
