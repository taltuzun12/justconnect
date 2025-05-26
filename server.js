case 'leaveChat':
                    // Client wants to leave the current chat.
                    const leaverId = data.userId;
                    const leaverWs = connectedClients.get(leaverId)?.ws; // Get the WebSocket for the user who is leaving

                    // Handle disconnection logic, which also notifies the partner
                    handleUserDisconnection(leaverId, false); // 'false' because it's a full leave, not skipping

                    // Send a confirmation back to the user who initiated the leave
                    if (leaverWs && leaverWs.readyState === WebSocket.OPEN) {
                        leaverWs.send(JSON.stringify({ type: 'chatEnded', userId: leaverId }));
                        console.log(`Sent chatEnded confirmation to ${leaverId}.`);
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
        // Call the disconnection handler, indicating it's a full disconnect (not skipping).
        handleUserDisconnection(userId, false);
    });

    // Event listener for WebSocket errors.
    ws.on('error', error => {
        console.error(`WebSocket error for client ${userId}:`, error);
        // Clean up user state on error, treating it as a full disconnect.
        handleUserDisconnection(userId, false);
    });
});
