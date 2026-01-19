// src/bg/background.js (MV3-compatible)

let authToken = null;
let isPosting = false;

// Function to extract token from Discord's webpack
async function extractToken() {
  try {
    const [tab] = await chrome.tabs.query({ 
      active: true, 
      currentWindow: true,
      url: "*://*.discord.com/*"
    });
    
    if (!tab) {
      console.error("No Discord tab found");
      return null;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          // Check if webpack chunk exists
          if (!window.webpackChunkdiscord_app) {
            console.error("webpackChunkdiscord_app not found");
            return null;
          }

          let foundToken = null;
          
          // Temporarily push our extraction function
          window.webpackChunkdiscord_app.push([
            [Symbol()],
            {},
            (req) => {
              if (!req.c) return;
              
              for (const m of Object.values(req.c)) {
                try {
                  if (!m.exports || m.exports === window) continue;
                  
                  // Check m.exports.getToken
                  if (m.exports?.getToken) {
                    foundToken = m.exports.getToken();
                    break;
                  }
                  
                  // Check nested exports
                  for (const ex in m.exports) {
                    const exportObj = m.exports[ex];
                    if (exportObj?.getToken && 
                        exportObj[Symbol.toStringTag] !== 'IntlMessagesProxy') {
                      foundToken = exportObj.getToken();
                      break;
                    }
                  }
                  
                  if (foundToken) break;
                } catch (e) {
                  // Continue searching
                }
              }
            }
          ]);
          
          // Pop our function
          window.webpackChunkdiscord_app.pop();
          
          return foundToken;
        } catch (error) {
          console.error("Token extraction error:", error);
          return null;
        }
      }
    });

    authToken = results[0]?.result;
    
    if (authToken) {
      console.log("Token successfully extracted");
    } else {
      console.error("Failed to extract token");
    }
    
    return authToken;
  } catch (error) {
    console.error("Extraction failed:", error);
    return null;
  }
}

// Message listener
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  switch (request.msg) {
    case "extractToken":
      const token = await extractToken();
      sendResponse({ 
        success: !!token, 
        token: token 
      });
      break;

    case "startSpam":
      if (!authToken) {
        const token = await extractToken();
        if (!token) {
          sendResponse({ 
            success: false, 
            error: "Could not extract authentication token" 
          });
          return;
        }
        authToken = token;
      }

      if (!request.data?.url || !request.data.emoji) {
        sendResponse({ 
          success: false, 
          error: "Missing required data (URL or emoji)" 
        });
        return;
      }

      try {
        // Extract channel ID from Discord URL
        const urlParts = request.data.url.split("/");
        const channelIdIndex = urlParts.findIndex(part => 
          part === "channels" || part === "channel"
        );
        
        let channelId = null;
        if (channelIdIndex !== -1 && channelIdIndex + 1 < urlParts.length) {
          channelId = urlParts[channelIdIndex + 1];
        } else {
          // Try to get from end of URL
          channelId = urlParts[urlParts.length - 1];
        }

        if (!channelId || !/^\d{17,19}$/.test(channelId)) {
          sendResponse({ 
            success: false, 
            error: "Invalid channel ID format" 
          });
          return;
        }

        isPosting = true;
        sendResponse({ success: true, channelId });
        
        // Start posting asynchronously
        startPosting(channelId, encodeURIComponent(request.data.emoji));
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      return true; // Keep message channel open

    case "stopSpam":
      isPosting = false;
      sendResponse({ success: true, stopped: true });
      break;

    case "getStatus":
      sendResponse({ 
        isPosting, 
        hasToken: !!authToken,
        tokenLength: authToken?.length || 0
      });
      break;
  }
});

async function startPosting(channelId, emoji) {
  if (!authToken || !isPosting) return;

  try {
    // Fetch recent messages
    const response = await fetch(
      `https://discord.com/api/v9/channels/${channelId}/messages?limit=50`,
      { 
        headers: { 
          "Authorization": authToken,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Invalid token - please reauthenticate");
      }
      throw new Error(`API error: ${response.status}`);
    }

    const messages = await response.json();
    
    if (!Array.isArray(messages) || messages.length === 0) {
      chrome.runtime.sendMessage({ 
        msg: "spamComplete", 
        info: "No messages found in channel" 
      });
      return;
    }

    // Process messages in order
    const messageIds = messages.map(m => m.id).reverse();
    
    // Add reactions with delay
    for (const messageId of messageIds) {
      if (!isPosting) break;
      
      try {
        await addReaction(channelId, messageId, emoji);
        
        // Send progress update
        chrome.runtime.sendMessage({ 
          msg: "reactionAdded", 
          progress: messageIds.indexOf(messageId) + 1,
          total: messageIds.length
        });
        
        // Delay between reactions (respectful rate limit)
        await new Promise(resolve => setTimeout(resolve, 1200));
      } catch (error) {
        console.error(`Failed to react to message ${messageId}:`, error);
      }
    }

    chrome.runtime.sendMessage({ 
      msg: "spamComplete", 
      success: true 
    });
  } catch (error) {
    console.error('Error in startPosting:', error);
    chrome.runtime.sendMessage({ 
      msg: "spamComplete", 
      error: error.message 
    });
  }
}

async function addReaction(channelId, messageId, emoji) {
  const response = await fetch(
    `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`,
    {
      method: "PUT",
      headers: { 
        "Authorization": authToken,
        "Content-Type": "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Reaction failed: ${response.status}`);
  }

  return true;
}
