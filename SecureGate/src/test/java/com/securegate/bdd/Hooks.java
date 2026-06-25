package com.securegate.bdd;

import com.securegate.support.SutPreflight;
import io.cucumber.java.Before;
import org.junit.jupiter.api.Assumptions;

/**
 * Skips every BDD scenario with one clear, actionable message when the Shipping Hub is down, instead
 * of letting the first API-backed step throw a raw "Connection refused".
 *
 * <p>This is a per-scenario {@code @Before} hook (not a run-level {@code @BeforeAll}) on purpose:
 * Cucumber maps an {@link org.opentest4j.TestAbortedException} — what {@link Assumptions#assumeTrue}
 * throws — to a SKIPPED scenario, so a down stack leaves the whole suite cleanly "ignored", matching
 * how the API/UI base classes abort. A {@code @BeforeAll} failure, by contrast, would error the run.
 * See {@link com.securegate.support.SutPreflight}.
 */
public final class Hooks {

  @Before
  public void requireShippingHub() {
    // Bring the local Shipping Hub up if it is down (no-op once it is running), so green-arrowing the
    // BDD scenarios in the IDE just works instead of skipping the whole suite. See SutPreflight.
    SutPreflight.ensureLocalStackReady();
    Assumptions.assumeTrue(SutPreflight.isApiReady(), SutPreflight::apiNotReadyMessage);
  }
}
