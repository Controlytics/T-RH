-- Drop Instrument.transport.
--
-- Spec decision D3 pinned every instrument to exactly one transport at
-- creation so the detail page could show one unambiguous connection example.
-- That asserted a constraint the system never enforced: `resolveInstrumentByToken`
-- authenticates on the credential alone and never looks at transport, so a
-- token issued to an "mqtt" instrument has always worked on the HTTP listener.
-- The detail page now ships a switcher over all seven protocols, so the stored
-- column has no remaining consumer and no enforcement behind it.
--
-- `dead_letters.transport` is deliberately NOT touched: that records how a
-- payload actually arrived, which is an observed fact rather than a claim, and
-- it stays meaningful once instruments are no longer pinned.

ALTER TABLE "instruments" DROP COLUMN "transport";
