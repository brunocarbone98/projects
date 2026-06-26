package com.securegate.ui;

import static io.cucumber.junit.platform.engine.Constants.GLUE_PROPERTY_NAME;
import static io.cucumber.junit.platform.engine.Constants.PLUGIN_PROPERTY_NAME;

import org.junit.platform.suite.api.ConfigurationParameter;
import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

/**
 * Runs the Serenity + Cucumber UI acceptance suite (Screenplay) on the JUnit Platform.
 *
 * <p>EXCLUDED from the default {@code mvn verify} (the UI scenarios need the web app on :3000 plus a
 * real browser). The CI ui job runs it with the web up via the {@code ui} Maven profile:
 * {@code mvn verify -Pui}. Reports are aggregated by the Serenity Maven plugin into
 * {@code target/site/serenity}.
 */
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features/ui")
@ConfigurationParameter(key = GLUE_PROPERTY_NAME, value = "com.securegate.ui.stepdefs")
@ConfigurationParameter(
    key = PLUGIN_PROPERTY_NAME,
    value = "net.serenitybdd.cucumber.core.plugin.SerenityReporterParallel")
public class UiAcceptanceTest {}
