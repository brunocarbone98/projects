package com.securegate.bdd;

import static io.cucumber.junit.platform.engine.Constants.GLUE_PROPERTY_NAME;

import org.junit.platform.suite.api.ConfigurationParameter;
import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

/**
 * Phase 2 — runs the Cucumber BDD scenarios on the JUnit Platform. As an {@code *IT} class it is
 * executed by the Failsafe plugin during {@code mvn verify}. Filter scenarios by tag with
 * {@code -Dcucumber.filter.tags="@public"}.
 */
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
@ConfigurationParameter(key = GLUE_PROPERTY_NAME, value = "com.securegate.bdd")
public class RunCucumberIT {}
