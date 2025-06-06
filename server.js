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
 * Broadcasts the current number of connected clients to all connected WebSocket clients.
 */
function broadcastActiveUserCount() {
    const activeUserCount = connectedClients.size;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'activeUsers', count: activeUserCount }));
        }
    });
    console.log(`Broadcasted active user count: ${activeUserCount}`);
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
    if (clientInfo) { // Ensure clientInfo exists before accessing properties
        if (clientInfo.searchTimeout) {
            clearTimeout(clientInfo.searchTimeout);
            clientInfo.searchTimeout = null;
            console.log(`Search timeout cleared for user ${disconnectedUserId}.`);
        }

        // IMPORTANT FIX: Reset gender and lookingFor preferences if not a full disconnection.
        // This ensures the user is treated as new for matching purposes after leaving a chat.
        if (!isSkipping) { // This condition is true when 'leaveChat' is called
            clientInfo.gender = null; // Reset gender preference
            clientInfo.lookingFor = null; // Reset lookingFor preference
            // No need for connectedClients.set(disconnectedUserId, clientInfo) here
            // because Maps store references to objects, so modifying clientInfo directly updates the map.
            console.log(`Reset preferences for user ${disconnectedUserId} after leaving chat.`);
        }
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

    // The connectedClients.delete(disconnectedUserId) is now ONLY in ws.on('close').
    // The broadcast is handled by ws.on('close') for full disconnects.
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
        const queuedUser = waitingQueue[i];
        const queuedUserWs = connectedClients.get(queuedUser.userId)?.ws;

        // Ensure the queued user is still connected, their WebSocket is open,
        // and they are not already paired with someone else.
        if (queuedUserWs && queuedUserWs.readyState === WebSocket.OPEN && !activePairs.has(queuedUser.userId)) {
            // Check if the current user and the queued user can be matched.
            if (canMatch({ userId, gender, lookingFor }, queuedUser)) {
                // A suitable partner is found! Remove them from the waiting queue.
                waitingQueue.splice(i, 1);

                // Establish the pairing in both directions in the activePairs map.
                activePairs.set(userId, queuedUser.userId);
                activePairs.set(queuedUser.userId, userId);

                // Clear the search timeout for the current user if it was set.
                if (clientInfo.searchTimeout) {
                    clearTimeout(clientInfo.searchTimeout);
                    clientInfo.searchTimeout = null;
                }
                // Clear the search timeout for the matched partner as well.
                const partnerClientInfo = connectedClients.get(queuedUser.userId);
                if (partnerClientInfo && partnerClientInfo.searchTimeout) {
                    clearTimeout(partnerClientInfo.searchTimeout);
                    partnerClientInfo.searchTimeout = null;
                }

                // Notify both clients that they have found a partner.
                ws.send(JSON.stringify({ type: 'foundPartner', partnerId: queuedUser.userId }));
                queuedUserWs.send(JSON.stringify({ type: 'foundPartner', partnerId: userId }));
                console.log(`Paired ${userId} (Gender: ${gender}, Looking: ${lookingFor}) with ${queuedUser.userId} (Gender: ${queuedUser.gender}, Looking: ${queuedUser.lookingFor})`);
                partnerFound = true; // Set flag to true
                break; // Exit the loop as a partner has been found
            }
        } else {
            // If a user in the queue is no longer connected or is already paired, clean them up.
            console.log(`Cleaning up disconnected/paired user ${queuedUser.userId} from waiting queue.`);
            waitingQueue.splice(i, 1); // Remove them from the queue
        }
    }

    if (!partnerFound) {
        // If no partner was found after checking the entire queue,
        // add the current user to the waiting queue.
        // First, check if the user is already in the queue (e.g., if they are skipping and re-requesting).
        const isInQueue = waitingQueue.some(u => u.userId === userId);
        if (!isInQueue) {
            // If not in queue, add them.
            waitingQueue.push({ userId, gender, lookingFor });
            console.log(`${userId} (Gender: ${gender}, Looking: ${lookingFor}) added to waiting queue.`);

            // Set a timeout to cancel the search after 15 seconds.
            clientInfo.searchTimeout = setTimeout(() => {
                // Remove the user from the waiting queue.
                const index = waitingQueue.findIndex(u => u.userId === userId);
                if (index > -1) {
                    waitingQueue.splice(index, 1);
                    console.log(`Search timed out for user ${userId}. Removed from waiting queue.`);
                }
                // Send the user back to the first searching page (you'll need to define this message type on the client).
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'searchCancelled' }));
                }
                // Clear the timeout.
                clientInfo.searchTimeout = null;
            }, 15000); // 15 seconds timeout
        } else {
            // If already in queue, log that their request was received again.
            console.log(`${userId} already in waiting queue, re-request ignored.`);
        }
        // Inform the client that they are now waiting for a partner.
        ws.send(JSON.stringify({ type: 'waiting' }));
    }
}


// Event listener for new client connections to the WebSocket server.
wss.on('connection', (ws, req) => { // 'req' is added to get the client IP
    // Generate a unique ID for each new client.
    const userId = uuidv4();
    // Get the client's IP address (when running behind proxies like Render.com, it's safer to use 'x-forwarded-for' header)
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Store the client's WebSocket instance along with initial null preferences and null timeout.
    connectedClients.set(userId, { ws: ws, gender: null, lookingFor: null, searchTimeout: null });

    console.log(`A new client connected. Assigned User ID: ${userId}, IP: ${clientIp}`);

    // Send the newly assigned userId back to the client so they know their ID.
    ws.send(JSON.stringify({ type: 'userId', userId: userId }));

    // Immediately send the current active user count to the newly connected client.
    ws.send(JSON.stringify({ type: 'activeUsers', count: connectedClients.size }));

    // Broadcast the updated active user count to all other connected clients.
    broadcastActiveUserCount();


    // --- Rate Limiting Check on Connection (Optional, but good for initial flood) ---
    // Initialize or update IP request count
    const now = Date.now();
    let ipData = ipRequestCounts.get(clientIp);
    if (!ipData || (now - ipData.lastReset > RATE_LIMIT_WINDOW_MS)) {
        ipData = { count: 0, lastReset: now };
    }
    ipData.count++;
    ipRequestCounts.set(clientIp, ipData);

    if (ipData.count > MAX_REQUESTS_PER_WINDOW * 2) { // A stricter limit for initial connection flood
        console.warn(`IP ${clientIp} exceeded connection rate limit. Denying connection.`);
        ws.send(JSON.stringify({ type: 'error', message: 'Too many connection attempts from your IP. Please try again later.' }));
        ws.close(1008, 'Rate limit exceeded'); // Close connection with a specific code
        return; // Stop processing this connection
    }
    // --- End Rate Limiting Check on Connection ---


    // Event listener for messages received from this specific client.
    ws.on('message', async message => {
        console.log(`Message received from user ${userId}: ${message}`);

        try {
            // Attempt to parse the incoming message as a JSON object.
            const data = JSON.parse(message);

            // Use a switch statement to handle different types of messages from the client.
            switch (data.type) {
                case 'register':
                    // This case is for when the client confirms its registration.
                    // The userId is already assigned at connection.
                    console.log(`Client ${userId} registered.`);
                    break;

                case 'findPartner':
                    // Client wants to find a chat partner based on their preferences.
                    const { gender, lookingFor } = data;

                    // --- Rate Limiting Check for findPartner requests ---
                    const currentClientIp = req.headers['x-forwarded-for'] || ws._socket.remoteAddress;
                    let findPartnerIpData = ipRequestCounts.get(currentClientIp);
                    if (!findPartnerIpData || (now - findPartnerIpData.lastReset > RATE_LIMIT_WINDOW_MS)) {
                        findPartnerIpData = { count: 0, lastReset: now };
                    }
                    findPartnerIpData.count++;
                    ipRequestCounts.set(currentClientIp, findPartnerIpData);

                    if (findPartnerIpData.count > MAX_REQUESTS_PER_WINDOW) {
                        console.warn(`IP ${currentClientIp} exceeded findPartner rate limit.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Too many search requests. Please wait a moment and try again.' }));
                        return; // Stop processing this request
                    }
                    // --- End Rate Limiting Check ---

                    // Update the connectedClients map with the user's provided preferences.
                    const clientInfo = connectedClients.get(userId);
                    if (clientInfo) {
                        clientInfo.gender = gender;
                        clientInfo.lookingFor = lookingFor;
                        // No need to set connectedClients.set(userId, clientInfo) again here
                        // as clientInfo is a reference to the object in the map.
                    } else {
                        // Log an error if the client's info isn't found (shouldn't happen if userId is correctly managed).
                        console.error(`Error: Client ${userId} not found in connectedClients map.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'User not registered.' }));
                        return; // Exit function if user not found
                    }

                    // Move partner finding and matching logic to a separate function
                    findAndMatchPartner(ws, userId, gender, lookingFor);
                    break;

                case 'message':
                    // Client sent a chat message.
                    const senderId = data.senderId;
                    const receiverId = activePairs.get(senderId); // Get the partner's ID from activePairs.

                    if (receiverId) {
                        // If a receiver (partner) is found, get their WebSocket object.
                        const receiverWs = connectedClients.get(receiverId)?.ws;
                        // Check if the receiver's WebSocket is open before sending.
                        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
                            // Relay the message to the partner.
                            receiverWs.send(JSON.stringify({
                                type: 'message',
                                senderId: senderId,
                                text: data.text
                            }));
                            console.log(`Message from ${senderId} to ${receiverId}: ${data.text}`);
                        } else {
                            // If the partner is no longer connected, notify the sender.
                            ws.send(JSON.stringify({ type: 'error', message: 'Your partner has disconnected.' }));
                            console.log(`Failed to send message: Partner ${receiverId} not found or not open.`);
                            // Clean up the pairing if the partner unexpectedly disconnected.
                            handleUserDisconnection(receiverId, false); // Treat as a full disconnect for partner's side
                        }
                    } else {
                        // If no partner is found for the sender, notify them.
                        ws.send(JSON.stringify({ type: 'error', message: 'You are not connected to a partner.' }));
                        console.log(`Message from ${senderId} failed: No partner found.`);
                    }
                    break;

                case 'leaveChat':
                    // Client wants to leave the current chat.
                    const leaverId = data.userId;
                    const leaverWs = connectedClients.get(leaverId)?.ws; // Get the WebSocket for the user who is leaving
                    const partnerIdOnLeave = activePairs.get(leaverId); // Get partner ID before handling disconnection

                    // Handle disconnection logic, which also notifies the partner.
                    // IMPORTANT: We explicitly set isSkipping to false here. This will trigger
                    // the preference reset in handleUserDisconnection for the leaver.
                    handleUserDisconnection(leaverId, false);

                    // Send a confirmation back to the user who initiated the leave
                    if (leaverWs && leaverWs.readyState === WebSocket.OPEN) {
                        leaverWs.send(JSON.stringify({ type: 'chatEnded', userId: leaverId }));
                        console.log(`Sent chatEnded confirmation to ${leaverId}.`);
                    }

                    // Notify the partner that the other user has left
                    if (partnerIdOnLeave) {
                        const partnerWsOnLeave = connectedClients.get(partnerIdOnLeave)?.ws;
                        if (partnerWsOnLeave && partnerWsOnLeave.readyState === WebSocket.OPEN) {
                            partnerWsOnLeave.send(JSON.stringify({ type: 'userLeft', userId: leaverId })); // Use 'userLeft' for partner
                            console.log(`Notified ${partnerIdOnLeave} that ${leaverId} has left.`);
                        } else {
                            console.log(`Partner ${partnerIdOnLeave} of ${leaverId} was not found or not open.`);
                            // Clean up the pairing on the partner's side as well if needed
                            if (activePairs.get(partnerIdOnLeave) === leaverId) {
                                activePairs.delete(partnerIdOnLeave);
                            }
                        }
                    }
                    break;

                default:
                    // Handle any unknown message types.
                    console.warn(`Unknown message type received from user ${userId}: ${data.type}`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type.' }));
                    break;
            }
        } catch (error) {
            // Catch and log any errors that occur during JSON parsing or message handling.
            console.error(`Error parsing message from user ${userId}: ${message}. Error: ${error.message}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message received.' }));
        }
    });

    // Event listener for when a client's WebSocket connection closes.
    ws.on('close', (code, reason) => { // Added code and reason for better logging
        console.log(`Client ${userId} disconnected. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
        // This is the ONLY place where the client should be removed from connectedClients.
        connectedClients.delete(userId);
        console.log(`${userId} removed from connected clients (due to WebSocket close).`);
        // Call the disconnection handler to clean up queue/pairs and notify partner.
        // We pass 'true' for isSkipping here because the client is no longer connected via WS.
        // This prevents handleUserDisconnection from trying to reset preferences on a non-existent clientInfo.
        handleUserDisconnection(userId, true);
        broadcastActiveUserCount(); // Broadcast updated count after a client truly disconnects
    });

    // Event listener for WebSocket errors.
    ws.on('error', error => {
        console.error(`WebSocket error for client ${userId}:`, error);
        // On error, the 'close' event will usually follow, which handles cleanup.
        // No need to call handleUserDisconnection directly here.
    });
});
