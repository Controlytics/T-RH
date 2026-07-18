import { useEffect, useState, useCallback, useRef } from 'react';

const TAB_ID_KEY = 'digilog_active_tab_id'; // in localStorage - shared across tabs
const TAB_HEARTBEAT_KEY = 'digilog_tab_heartbeat'; // in localStorage
const TAB_USER_KEY = 'digilog_active_user_id'; // in localStorage
const SESSION_TAB_ID_KEY = 'digilog_tab_id'; // in sessionStorage - unique per tab, survives refresh
const HEARTBEAT_INTERVAL = 1000; // 1 second
const HEARTBEAT_TIMEOUT = 3000; // 3 seconds - if no heartbeat, tab is considered dead

// Get or create a tab ID that persists across page refreshes but is unique per browser tab
function getTabId(): string {
  let tabId = sessionStorage.getItem(SESSION_TAB_ID_KEY);
  if (!tabId) {
    tabId = Math.random().toString(36).substring(2, 15) + '_' + Date.now();
    sessionStorage.setItem(SESSION_TAB_ID_KEY, tabId);
  }
  return tabId;
}

export interface ActiveSessionInfo {
  userId: string;
  username: string;
  tabId: string;
}

/**
 * Hook to enforce single-tab and single-user usage per browser/system.
 * Uses localStorage to detect if another tab or user is already active.
 * Prevents both same user multi-tab and different users on same system.
 */
export function useSingleTab(isAuthenticated: boolean, currentUserId?: string, currentUsername?: string) {
  const [isDuplicateTab, setIsDuplicateTab] = useState(false);
  const [existingUserSession, setExistingUserSession] = useState<ActiveSessionInfo | null>(null);
  const tabId = useRef<string>(getTabId()); // Get persistent tab ID from sessionStorage
  const heartbeatInterval = useRef<ReturnType<typeof setInterval>>(undefined);

  // Check if another tab or user is active
  const checkForDuplicateTab = useCallback(() => {
    if (!isAuthenticated) {
      setIsDuplicateTab(false);
      setExistingUserSession(null);
      return false;
    }

    const myTabId = tabId.current;
    const activeTabId = localStorage.getItem(TAB_ID_KEY);
    const lastHeartbeat = localStorage.getItem(TAB_HEARTBEAT_KEY);
    const activeUserData = localStorage.getItem(TAB_USER_KEY);

    // If there's an active tab with a different ID
    if (activeTabId && activeTabId !== myTabId) {
      // Check if the other tab is still alive (heartbeat within timeout)
      if (lastHeartbeat) {
        const timeSinceHeartbeat = Date.now() - parseInt(lastHeartbeat, 10);
        if (timeSinceHeartbeat < HEARTBEAT_TIMEOUT) {
          // Other tab is still alive - it's a duplicate
          if (activeUserData) {
            try {
              const parsedData = JSON.parse(activeUserData) as ActiveSessionInfo;
              if (parsedData.userId !== currentUserId) {
                // Different user is logged in
                setExistingUserSession(parsedData);
              }
            } catch {
              // Invalid data, ignore
            }
          }
          setIsDuplicateTab(true);
          return true;
        }
      }
    }

    // No active tab or other tab is dead - claim this tab as active
    localStorage.setItem(TAB_ID_KEY, myTabId);
    localStorage.setItem(TAB_HEARTBEAT_KEY, Date.now().toString());
    if (currentUserId && currentUsername) {
      localStorage.setItem(TAB_USER_KEY, JSON.stringify({
        userId: currentUserId,
        username: currentUsername,
        tabId: myTabId,
      }));
    }
    setIsDuplicateTab(false);
    setExistingUserSession(null);
    return false;
  }, [isAuthenticated, currentUserId, currentUsername]);

  // Send heartbeat to indicate this tab is still active
  const sendHeartbeat = useCallback(() => {
    const myTabId = tabId.current;
    const activeTabId = localStorage.getItem(TAB_ID_KEY);
    if (activeTabId === myTabId) {
      localStorage.setItem(TAB_HEARTBEAT_KEY, Date.now().toString());
      // Also update user data in case it wasn't set
      if (currentUserId && currentUsername) {
        localStorage.setItem(TAB_USER_KEY, JSON.stringify({
          userId: currentUserId,
          username: currentUsername,
          tabId: myTabId,
        }));
      }
    }
  }, [currentUserId, currentUsername]);

  // Claim this tab as the active one (force takeover)
  const claimActiveTab = useCallback(() => {
    const myTabId = tabId.current;
    localStorage.setItem(TAB_ID_KEY, myTabId);
    localStorage.setItem(TAB_HEARTBEAT_KEY, Date.now().toString());
    if (currentUserId && currentUsername) {
      localStorage.setItem(TAB_USER_KEY, JSON.stringify({
        userId: currentUserId,
        username: currentUsername,
        tabId: myTabId,
      }));
    }
    setIsDuplicateTab(false);
    setExistingUserSession(null);
  }, [currentUserId, currentUsername]);

  // Release the active tab claim (on logout or unmount)
  const releaseTab = useCallback(() => {
    const activeTabId = localStorage.getItem(TAB_ID_KEY);
    if (activeTabId === tabId.current) {
      localStorage.removeItem(TAB_ID_KEY);
      localStorage.removeItem(TAB_HEARTBEAT_KEY);
      localStorage.removeItem(TAB_USER_KEY);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      // Clear heartbeat when not authenticated
      if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
      }
      releaseTab();
      return;
    }

    // Initial check
    const isDuplicate = checkForDuplicateTab();

    if (!isDuplicate) {
      // Start heartbeat
      heartbeatInterval.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    }

    // Listen for storage changes from other tabs
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === TAB_ID_KEY && e.newValue && e.newValue !== tabId.current) {
        // Another tab has claimed to be active
        setIsDuplicateTab(true);
        if (heartbeatInterval.current) {
          clearInterval(heartbeatInterval.current);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);

    // Cleanup on unmount
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
      }
      releaseTab();
    };
  }, [isAuthenticated, checkForDuplicateTab, sendHeartbeat, releaseTab]);

  // Handle page visibility change - reclaim when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isAuthenticated && !isDuplicateTab) {
        // Tab became visible, refresh our claim
        const myTabId = tabId.current;
        localStorage.setItem(TAB_ID_KEY, myTabId);
        localStorage.setItem(TAB_HEARTBEAT_KEY, Date.now().toString());
        if (currentUserId && currentUsername) {
          localStorage.setItem(TAB_USER_KEY, JSON.stringify({
            userId: currentUserId,
            username: currentUsername,
            tabId: myTabId,
          }));
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isAuthenticated, isDuplicateTab, currentUserId, currentUsername]);

  return {
    isDuplicateTab,
    existingUserSession,
    claimActiveTab,
    releaseTab,
  };
}

/**
 * Utility function to check if another user is logged in on this system.
 * Used on login page before authenticating.
 */
export function checkExistingUserSession(): ActiveSessionInfo | null {
  const myTabId = getTabId(); // Get this tab's ID
  const activeTabId = localStorage.getItem(TAB_ID_KEY);
  const lastHeartbeat = localStorage.getItem(TAB_HEARTBEAT_KEY);
  const activeUserData = localStorage.getItem(TAB_USER_KEY);

  if (!activeTabId || !lastHeartbeat || !activeUserData) {
    return null;
  }

  // If it's our own tab, no conflict
  if (activeTabId === myTabId) {
    return null;
  }

  // Check if the session is still alive
  const timeSinceHeartbeat = Date.now() - parseInt(lastHeartbeat, 10);
  if (timeSinceHeartbeat >= HEARTBEAT_TIMEOUT) {
    // Session is dead, clean up
    localStorage.removeItem(TAB_ID_KEY);
    localStorage.removeItem(TAB_HEARTBEAT_KEY);
    localStorage.removeItem(TAB_USER_KEY);
    return null;
  }

  try {
    return JSON.parse(activeUserData) as ActiveSessionInfo;
  } catch {
    return null;
  }
}
