package com.securegate.support;

import java.io.InputStream;
import java.util.Properties;

/**
 * Loads the environment configuration for the system under test (Shipping Hub).
 *
 * <p>The target environment is chosen with {@code -Denv=local|live} (default {@code local})
 * and loaded from {@code config/<env>.properties} on the test classpath. Any individual key
 * can be overridden from the command line, e.g. {@code -DapiBaseUrl=http://host:4000}.
 */
public final class Config {

  private static final Config INSTANCE = load();

  private final Properties props;

  private Config(Properties props) {
    this.props = props;
  }

  public static Config get() {
    return INSTANCE;
  }

  private static Config load() {
    String env = System.getProperty("env", System.getenv().getOrDefault("ENV", "local"));
    String resource = "config/" + env + ".properties";
    Properties props = new Properties();
    try (InputStream in = Config.class.getClassLoader().getResourceAsStream(resource)) {
      if (in == null) {
        throw new IllegalStateException(
            "Missing config resource '" + resource + "'. Use -Denv=local or -Denv=live.");
      }
      props.load(in);
    } catch (Exception e) {
      throw new IllegalStateException("Failed to load " + resource, e);
    }
    // Allow -Dkey=value to override any property from the file.
    for (String key : props.stringPropertyNames()) {
      String override = System.getProperty(key);
      if (override != null) {
        props.setProperty(key, override);
      }
    }
    return new Config(props);
  }

  public String env() {
    return System.getProperty("env", "local");
  }

  public String apiBaseUrl() {
    return require("apiBaseUrl");
  }

  public String webBaseUrl() {
    return require("webBaseUrl");
  }

  public String demoTrackingCode() {
    return require("demoTrackingCode");
  }

  public String customerEmail() {
    return require("customerEmail");
  }

  public String customerPassword() {
    return require("customerPassword");
  }

  public String adminEmail() {
    return require("adminEmail");
  }

  public String adminPassword() {
    return require("adminPassword");
  }

  private String require(String key) {
    String value = props.getProperty(key);
    if (value == null || value.isBlank()) {
      throw new IllegalStateException("Missing config key '" + key + "' for env '" + env() + "'.");
    }
    return value.trim();
  }
}
