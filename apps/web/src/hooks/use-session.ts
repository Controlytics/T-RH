import { useEffect, useRef, useState, useCallback } from 'react';

interface SessionConfig {
  autoLogoutEnabled: boolean;
  idleTimeoutMinutes: number;
  warningMinutes: number;
}

export function useSession(config: SessionConfig | null, onLogout: () => void) {
  const [showWarning, setShowWarning] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const showWarningRef = useRef(false);
  const configRef = useRef(config);
  const onLogoutRef = useRef(onLogout);

  // Track absolute times instead of intervals (more reliable for background tabs)
  const lastActivityRef = useRef(Date.now());
  const warningStartTimeRef = useRef<number | null>(null);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Update refs when values change
  configRef.current = config;
  onLogoutRef.current = onLogout;

  const clearTimers = useCallback(() => {
    if (checkIntervalRef.current) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = undefined;
    }
  }, []);

  const resetActivity = useCallback(() => {
    const cfg = configRef.current;
    if (!cfg?.autoLogoutEnabled) return;

    // Don't reset if warning is showing
    if (showWarningRef.current) return;

    lastActivityRef.current = Date.now();
  }, []);

  const checkTimeout = useCallback(() => {
    const cfg = configRef.current;
    if (!cfg?.autoLogoutEnabled) return;

    const now = Date.now();
    const idleTimeMs = cfg.idleTimeoutMinutes * 60 * 1000;
    const warningTimeMs = cfg.warningMinutes * 60 * 1000;
    const warningStartsAt = idleTimeMs - warningTimeMs;

    if (showWarningRef.current) {
      // In warning mode - check if we should logout
      const warningStart = warningStartTimeRef.current!;
      const elapsedSinceWarning = now - warningStart;
      const remainingMs = warningTimeMs - elapsedSinceWarning;

      if (remainingMs <= 0) {
        // Time's up - logout
        clearTimers();
        showWarningRef.current = false;
        warningStartTimeRef.current = null;
        setShowWarning(false);
        onLogoutRef.current();
      } else {
        // Update countdown
        setCountdown(Math.ceil(remainingMs / 1000));
      }
    } else {
      // Not in warning mode - check if we should start warning
      const idleTime = now - lastActivityRef.current;

      if (idleTime >= warningStartsAt) {
        // Start warning
        showWarningRef.current = true;
        warningStartTimeRef.current = now;
        setShowWarning(true);
        setCountdown(cfg.warningMinutes * 60);
      }
    }
  }, [clearTimers]);

  useEffect(() => {
    if (!config?.autoLogoutEnabled) {
      clearTimers();
      setShowWarning(false);
      showWarningRef.current = false;
      warningStartTimeRef.current = null;
      return;
    }

    // Activity event listeners - only track click, key, scroll, touch
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];

    const handleActivity = () => {
      if (!showWarningRef.current) {
        resetActivity();
      }
    };

    events.forEach((e) => window.addEventListener(e, handleActivity, { passive: true }));

    // Initialize last activity time
    lastActivityRef.current = Date.now();

    // Check timeout every second - this will also fire when tab becomes active
    checkIntervalRef.current = setInterval(checkTimeout, 1000);

    // Also check on visibility change (when user returns to tab)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Immediately check timeout when tab becomes visible
        checkTimeout();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      events.forEach((e) => window.removeEventListener(e, handleActivity));
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearTimers();
    };
  }, [config?.autoLogoutEnabled, config?.idleTimeoutMinutes, config?.warningMinutes, resetActivity, checkTimeout, clearTimers]);

  const continueSession = useCallback(() => {
    showWarningRef.current = false;
    warningStartTimeRef.current = null;
    setShowWarning(false);
    setCountdown(0);
    lastActivityRef.current = Date.now();
  }, []);

  return { showWarning, countdown, continueSession };
}
