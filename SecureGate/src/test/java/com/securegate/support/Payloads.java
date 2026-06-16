package com.securegate.support;

import java.util.LinkedHashMap;
import java.util.Map;

/** Valid request payloads for the Shipping Hub API, reused by API tests and BDD steps. */
public final class Payloads {

  private Payloads() {}

  public static Map<String, Object> address(String contactName, String city, String country) {
    Map<String, Object> a = new LinkedHashMap<>();
    a.put("contactName", contactName);
    a.put("line1", "123 Test Street");
    a.put("city", city);
    a.put("postalCode", "00000");
    a.put("country", country);
    return a;
  }

  public static Map<String, Object> parcel() {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("weightGrams", 2000);
    p.put("lengthCm", 30);
    p.put("widthCm", 20);
    p.put("heightCm", 10);
    return p;
  }

  /** A valid create-shipment body (Panama City -> Miami, express). */
  public static Map<String, Object> newShipment() {
    Map<String, Object> s = new LinkedHashMap<>();
    s.put("origin", address("Ana Perez", "Panama City", "PA"));
    s.put("destination", address("John Doe", "Miami", "US"));
    s.put("serviceLevel", "EXPRESS");
    s.put("parcel", parcel());
    return s;
  }

  /** A valid quote body. */
  public static Map<String, Object> quote() {
    Map<String, Object> q = new LinkedHashMap<>();
    q.put("originCountry", "PA");
    q.put("destinationCountry", "US");
    q.put("weightGrams", 2000);
    q.put("lengthCm", 30);
    q.put("widthCm", 20);
    q.put("heightCm", 10);
    q.put("serviceLevel", "EXPRESS");
    return q;
  }
}
