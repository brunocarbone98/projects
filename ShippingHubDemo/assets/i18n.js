// Bilingual copy for the static demo. The message catalogs are copied verbatim
// from FullStackHub/apps/web/messages/{en,es}.json so the demo reads exactly
// like the real app. A tiny formatter covers the ICU features actually used
// here: {placeholder} interpolation and a single {count, plural, …} string.

const en = {
  "Metadata": {
    "siteName": "Shipping Hub",
    "title": "Shipping Hub — International parcel shipping & tracking",
    "description": "Ship and track parcels between Panama, the United States and Latin America."
  },
  "Nav": {
    "home": "Home",
    "track": "Track",
    "quote": "Get a quote",
    "coverage": "Coverage",
    "faq": "FAQ",
    "trackCta": "Track a package",
    "signIn": "Sign in"
  },
  "Home": {
    "hero": {
      "badge": "Panama · United States · Latin America",
      "title": "Ship anywhere. Track everything.",
      "subtitle": "Real-time parcel tracking and instant quotes across the Americas. Paste your tracking number — no sign-up needed.",
      "trackLabel": "Tracking number",
      "trackPlaceholder": "PTY-2026-001001-0",
      "trackButton": "Track",
      "quoteButton": "Get a quote",
      "example": "Try a demo code:"
    },
    "features": {
      "title": "Built for shippers and recipients",
      "tracking": { "title": "Public tracking", "description": "Anyone can follow a shipment's journey with just the tracking number — fast and shareable." },
      "coverage": { "title": "Regional coverage", "description": "Domestic Panama plus express and economy lanes to the US and across Latin America." },
      "pricing": { "title": "Transparent pricing", "description": "Volumetric-weight aware quotes with clear delivery estimates before you ship." },
      "api": { "title": "Developer friendly", "description": "The same state machine, Luhn tracking codes and zone pricing as the full-stack build." }
    },
    "steps": {
      "title": "How it works",
      "one": { "title": "Create a shipment", "description": "Enter origin, destination and parcel details to generate a label and tracking number." },
      "two": { "title": "We move it", "description": "Operations scan the parcel at each hub, writing immutable tracking events." },
      "three": { "title": "Track in real time", "description": "Share the tracking link — recipients see every update in their language." }
    },
    "cta": { "title": "Have a tracking number?", "subtitle": "Check the status of any shipment in seconds.", "button": "Track a package" }
  },
  "Tracking": {
    "search": {
      "title": "Track your shipment",
      "subtitle": "Enter your tracking number to see the latest status and full history.",
      "placeholder": "PTY-2026-001001-0",
      "button": "Track",
      "invalid": "That doesn't look like a valid tracking number. Expected format: PTY-YYYY-NNNNNN-C.",
      "example": "Demo code:"
    },
    "result": {
      "eyebrow": "Shipment",
      "estimated": "Estimated delivery",
      "noEstimate": "To be confirmed",
      "service": "Service",
      "route": "Route",
      "from": "From",
      "to": "To",
      "timelineTitle": "Tracking history",
      "latest": "Latest update",
      "searchAnother": "Track another package",
      "share": "Copy link",
      "shared": "Link copied",
      "createdAt": "Created"
    },
    "notFound": { "title": "We couldn't find that shipment", "body": "No shipment matches “{code}”. Double-check the number and try again.", "cta": "Try another number" }
  },
  "Status": {
    "CREATED": "Created", "LABEL_PAID": "Label paid", "PICKED_UP": "Picked up", "IN_TRANSIT": "In transit",
    "AT_DESTINATION_HUB": "At destination hub", "OUT_FOR_DELIVERY": "Out for delivery", "DELIVERED": "Delivered",
    "EXCEPTION": "Exception", "RETURNED_TO_SENDER": "Returned to sender", "CANCELLED": "Cancelled"
  },
  "ServiceLevel": { "EXPRESS": "Express", "STANDARD": "Standard", "ECONOMY": "Economy" },
  "Countries": {
    "PA": "Panama", "US": "United States", "CO": "Colombia", "MX": "Mexico", "PE": "Peru",
    "CL": "Chile", "CR": "Costa Rica", "AR": "Argentina", "EC": "Ecuador"
  },
  "Quote": {
    "title": "Get an instant quote",
    "subtitle": "Estimate the price and delivery time for your parcel. Origin is Panama City.",
    "form": { "destination": "Destination country", "weight": "Weight (kg)", "dimensions": "Dimensions (cm)", "length": "Length", "width": "Width", "height": "Height", "service": "Service level", "calculate": "Calculate" },
    "result": { "title": "Estimated quote", "price": "Estimated price", "eta": "Estimated transit time", "etaDays": "{min}–{max} business days", "zone": "Zone", "billable": "Billable weight", "disclaimer": "Estimate only. Final pricing is confirmed at checkout." }
  },
  "Coverage": {
    "title": "Where we ship",
    "subtitle": "Service levels and indicative transit times by destination zone. Origin is Panama.",
    "table": { "zone": "Zone", "express": "Express", "standard": "Standard", "economy": "Economy", "days": "{min}–{max} days" },
    "zones": {
      "PA": { "name": "Panama (domestic)", "countries": "Nationwide Panama" },
      "US": { "name": "United States", "countries": "All 50 states" },
      "LATAM": { "name": "Latin America", "countries": "Colombia, Mexico, Peru, Chile, Costa Rica, Argentina, Ecuador and more" }
    },
    "note": "Transit times are business days and exclude customs delays and local holidays."
  },
  "Faq": {
    "title": "Frequently asked questions",
    "subtitle": "Everything you need to know about tracking and shipping.",
    "items": [
      { "question": "Do I need an account to track a package?", "answer": "No. Tracking is public — just enter your tracking number on the tracking page and you'll see the full history." },
      { "question": "What does a tracking number look like?", "answer": "Tracking numbers follow the format PTY-YYYY-NNNNNN-C, where the last digit is a check digit that guards against typos." },
      { "question": "How often is tracking updated?", "answer": "Every time operations scan your parcel at a facility, an immutable tracking event is recorded and appears instantly on the public page." },
      { "question": "Which countries do you serve?", "answer": "We ship domestically within Panama and internationally to the United States and across Latin America." },
      { "question": "How is shipping priced?", "answer": "Pricing is based on destination zone, service level and billable weight (the greater of actual and volumetric weight)." }
    ]
  },
  "Footer": { "tagline": "International parcel shipping & tracking across the Americas.", "rights": "© {year} Shipping Hub. Demo portfolio project.", "builtWith": "Static demo — all data lives in your browser." },
  "Locale": { "label": "Language", "es": "Español", "en": "English" },
  "Auth": {
    "login": { "title": "Sign in", "subtitle": "Access your shipments dashboard.", "email": "Email", "password": "Password", "submit": "Sign in", "noAccount": "Don't have an account?", "registerLink": "Create one", "demoHint": "Demo accounts (password Password123!):" },
    "register": { "title": "Create your account", "subtitle": "Start creating and tracking shipments.", "name": "Full name", "email": "Email", "password": "Password", "passwordHint": "At least 8 characters", "submit": "Create account", "hasAccount": "Already have an account?", "loginLink": "Sign in" },
    "errors": { "required": "Please fill in all fields.", "invalid_credentials": "Invalid email or password.", "weak_password": "Password must be at least 8 characters.", "email_taken": "That email is already registered." }
  },
  "Dashboard": {
    "signedInAs": "Signed in as", "signOut": "Sign out",
    "nav": { "overview": "Overview", "shipments": "Shipments", "newShipment": "New shipment", "wallet": "Wallet" },
    "roles": { "CUSTOMER": "Customer", "COURIER": "Courier", "ADMIN": "Admin" },
    "overview": { "title": "Overview", "welcome": "Welcome back, {name}.", "customerLead": "Create a shipment or review your shipment history.", "staffLead": "Search shipments and register tracking events.", "totalShipments": "Your shipments", "createCta": "Create a shipment", "viewAll": "View all shipments" }
  },
  "Shipments": {
    "mineTitle": "My shipments", "allTitle": "All shipments", "empty": "No shipments yet.", "newShipment": "New shipment",
    "search": { "statusLabel": "Filter by status", "all": "All statuses" },
    "table": { "code": "Tracking", "status": "Status", "route": "Route", "service": "Service", "created": "Created", "price": "Price" },
    "view": "View", "resultCount": "{count, plural, one {# shipment} other {# shipments}}"
  },
  "Wallet": {
    "title": "Wallet", "balance": "Balance", "amount": "Amount (USD)", "addFunds": "Add funds", "invalidAmount": "Enter a valid amount.",
    "history": "Transaction history", "empty": "No transactions yet.", "kinds": { "TOPUP": "Top-up", "PAYMENT": "Payment", "REVERSAL": "Reversal" }
  },
  "ShipmentDetail": {
    "back": "Back to shipments", "downloadLabel": "Download label", "pay": "Pay {amount}", "payInsufficient": "Insufficient wallet balance — top up your wallet first.", "paid": "Label paid",
    "service": "Service", "estimated": "Estimated delivery", "noEstimate": "To be confirmed", "from": "From", "to": "To", "price": "Price", "weight": "Weight", "dimensions": "Dimensions", "timeline": "Tracking history",
    "registerEvent": { "title": "Register tracking event", "status": "New status", "location": "Location", "locationPlaceholder": "e.g. Miami, US", "description": "Description", "descriptionPlaceholder": "e.g. Arrived at destination hub", "submit": "Register event", "noTransitions": "This shipment has reached a final state and cannot be advanced.", "errorInvalid": "That transition is not allowed." }
  },
  "Wizard": {
    "title": "New shipment",
    "steps": { "addresses": "Addresses", "parcel": "Parcel", "service": "Service", "review": "Review" },
    "origin": "Origin", "destination": "Destination",
    "fields": { "contactName": "Contact name", "line1": "Address line 1", "city": "City", "state": "State / Province (optional)", "postalCode": "Postal code", "country": "Country", "weight": "Weight (kg)", "length": "Length (cm)", "width": "Width (cm)", "height": "Height (cm)", "serviceLevel": "Service level" },
    "estimate": { "title": "Estimated price", "eta": "Estimated transit", "etaDays": "{min}–{max} business days" },
    "review": { "title": "Review & confirm", "parcelSummary": "{weight} kg · {l}×{w}×{h} cm" },
    "back": "Back", "next": "Next", "submit": "Create shipment", "created": "Shipment {code} created.", "error": "Please complete every field."
  },
  "Demo": {
    "banner": "Static demo — everything runs in your browser, no server. Data is saved to localStorage.",
    "reset": "Reset demo data",
    "reseted": "Demo data reset."
  },
  "NotFound": { "title": "Page not found", "body": "The page you're looking for doesn't exist.", "home": "Back to home" }
};

const es = {
  "Metadata": {
    "siteName": "Shipping Hub",
    "title": "Shipping Hub — Envío y rastreo de paquetes internacionales",
    "description": "Envía y rastrea paquetes entre Panamá, Estados Unidos y Latinoamérica."
  },
  "Nav": { "home": "Inicio", "track": "Rastrear", "quote": "Cotizar", "coverage": "Cobertura", "faq": "Preguntas", "trackCta": "Rastrear un paquete", "signIn": "Iniciar sesión" },
  "Home": {
    "hero": {
      "badge": "Panamá · Estados Unidos · Latinoamérica",
      "title": "Envía a cualquier lugar. Rastrea todo.",
      "subtitle": "Rastreo de paquetes en tiempo real y cotizaciones instantáneas en toda América. Pega tu número de guía, sin registrarte.",
      "trackLabel": "Número de guía",
      "trackPlaceholder": "PTY-2026-001001-0",
      "trackButton": "Rastrear",
      "quoteButton": "Cotizar",
      "example": "Prueba un código demo:"
    },
    "features": {
      "title": "Hecho para quienes envían y reciben",
      "tracking": { "title": "Rastreo público", "description": "Cualquiera puede seguir el recorrido de un envío solo con el número de guía: rápido y fácil de compartir." },
      "coverage": { "title": "Cobertura regional", "description": "Panamá nacional más rutas express y económicas a Estados Unidos y por toda Latinoamérica." },
      "pricing": { "title": "Precios transparentes", "description": "Cotizaciones que consideran el peso volumétrico, con estimaciones de entrega claras antes de enviar." },
      "api": { "title": "Pensado para developers", "description": "La misma máquina de estados, códigos Luhn y pricing por zonas que la versión full-stack." }
    },
    "steps": {
      "title": "Cómo funciona",
      "one": { "title": "Crea un envío", "description": "Ingresa origen, destino y datos del paquete para generar la etiqueta y el número de guía." },
      "two": { "title": "Lo movemos", "description": "Operaciones escanea el paquete en cada bodega y registra eventos de rastreo inmutables." },
      "three": { "title": "Rastrea en tiempo real", "description": "Comparte el enlace de rastreo: el destinatario ve cada actualización en su idioma." }
    },
    "cta": { "title": "¿Tienes un número de guía?", "subtitle": "Consulta el estado de cualquier envío en segundos.", "button": "Rastrear un paquete" }
  },
  "Tracking": {
    "search": {
      "title": "Rastrea tu envío",
      "subtitle": "Ingresa tu número de guía para ver el estado más reciente y el historial completo.",
      "placeholder": "PTY-2026-001001-0",
      "button": "Rastrear",
      "invalid": "Eso no parece un número de guía válido. Formato esperado: PTY-AAAA-NNNNNN-C.",
      "example": "Código demo:"
    },
    "result": {
      "eyebrow": "Envío", "estimated": "Entrega estimada", "noEstimate": "Por confirmar", "service": "Servicio", "route": "Ruta",
      "from": "Desde", "to": "Hasta", "timelineTitle": "Historial de rastreo", "latest": "Última actualización",
      "searchAnother": "Rastrear otro paquete", "share": "Copiar enlace", "shared": "Enlace copiado", "createdAt": "Creado"
    },
    "notFound": { "title": "No encontramos ese envío", "body": "Ningún envío coincide con «{code}». Verifica el número e inténtalo de nuevo.", "cta": "Probar otro número" }
  },
  "Status": {
    "CREATED": "Creado", "LABEL_PAID": "Etiqueta pagada", "PICKED_UP": "Recolectado", "IN_TRANSIT": "En tránsito",
    "AT_DESTINATION_HUB": "En bodega destino", "OUT_FOR_DELIVERY": "En reparto", "DELIVERED": "Entregado",
    "EXCEPTION": "Excepción", "RETURNED_TO_SENDER": "Devuelto al remitente", "CANCELLED": "Cancelado"
  },
  "ServiceLevel": { "EXPRESS": "Express", "STANDARD": "Estándar", "ECONOMY": "Económico" },
  "Countries": {
    "PA": "Panamá", "US": "Estados Unidos", "CO": "Colombia", "MX": "México", "PE": "Perú",
    "CL": "Chile", "CR": "Costa Rica", "AR": "Argentina", "EC": "Ecuador"
  },
  "Quote": {
    "title": "Cotiza al instante",
    "subtitle": "Estima el precio y el tiempo de entrega de tu paquete. El origen es Ciudad de Panamá.",
    "form": { "destination": "País de destino", "weight": "Peso (kg)", "dimensions": "Dimensiones (cm)", "length": "Largo", "width": "Ancho", "height": "Alto", "service": "Nivel de servicio", "calculate": "Calcular" },
    "result": { "title": "Cotización estimada", "price": "Precio estimado", "eta": "Tiempo de tránsito estimado", "etaDays": "{min}–{max} días hábiles", "zone": "Zona", "billable": "Peso facturable", "disclaimer": "Solo una estimación. El precio final se confirma al pagar." }
  },
  "Coverage": {
    "title": "A dónde enviamos",
    "subtitle": "Niveles de servicio y tiempos de tránsito indicativos por zona de destino. El origen es Panamá.",
    "table": { "zone": "Zona", "express": "Express", "standard": "Estándar", "economy": "Económico", "days": "{min}–{max} días" },
    "zones": {
      "PA": { "name": "Panamá (nacional)", "countries": "Todo Panamá" },
      "US": { "name": "Estados Unidos", "countries": "Los 50 estados" },
      "LATAM": { "name": "Latinoamérica", "countries": "Colombia, México, Perú, Chile, Costa Rica, Argentina, Ecuador y más" }
    },
    "note": "Los tiempos de tránsito son días hábiles y no incluyen demoras de aduana ni feriados locales."
  },
  "Faq": {
    "title": "Preguntas frecuentes",
    "subtitle": "Todo lo que necesitas saber sobre rastreo y envíos.",
    "items": [
      { "question": "¿Necesito una cuenta para rastrear un paquete?", "answer": "No. El rastreo es público: solo ingresa tu número de guía en la página de rastreo y verás el historial completo." },
      { "question": "¿Cómo es un número de guía?", "answer": "Los números de guía siguen el formato PTY-AAAA-NNNNNN-C, donde el último dígito es un dígito verificador que protege contra errores de tipeo." },
      { "question": "¿Con qué frecuencia se actualiza el rastreo?", "answer": "Cada vez que operaciones escanea tu paquete en una bodega se registra un evento de rastreo inmutable que aparece al instante en la página pública." },
      { "question": "¿A qué países llegan?", "answer": "Enviamos dentro de Panamá e internacionalmente a Estados Unidos y por toda Latinoamérica." },
      { "question": "¿Cómo se calcula el precio del envío?", "answer": "El precio se basa en la zona de destino, el nivel de servicio y el peso facturable (el mayor entre el peso real y el volumétrico)." }
    ]
  },
  "Footer": { "tagline": "Envío y rastreo de paquetes internacionales en toda América.", "rights": "© {year} Shipping Hub. Proyecto de portafolio.", "builtWith": "Demo estática — todos los datos viven en tu navegador." },
  "Locale": { "label": "Idioma", "es": "Español", "en": "English" },
  "Auth": {
    "login": { "title": "Iniciar sesión", "subtitle": "Accede a tu panel de envíos.", "email": "Correo", "password": "Contraseña", "submit": "Iniciar sesión", "noAccount": "¿No tienes cuenta?", "registerLink": "Crea una", "demoHint": "Cuentas demo (contraseña Password123!):" },
    "register": { "title": "Crea tu cuenta", "subtitle": "Empieza a crear y rastrear envíos.", "name": "Nombre completo", "email": "Correo", "password": "Contraseña", "passwordHint": "Mínimo 8 caracteres", "submit": "Crear cuenta", "hasAccount": "¿Ya tienes cuenta?", "loginLink": "Inicia sesión" },
    "errors": { "required": "Completa todos los campos.", "invalid_credentials": "Correo o contraseña inválidos.", "weak_password": "La contraseña debe tener al menos 8 caracteres.", "email_taken": "Ese correo ya está registrado." }
  },
  "Dashboard": {
    "signedInAs": "Sesión de", "signOut": "Cerrar sesión",
    "nav": { "overview": "Resumen", "shipments": "Envíos", "newShipment": "Nuevo envío", "wallet": "Billetera" },
    "roles": { "CUSTOMER": "Cliente", "COURIER": "Mensajero", "ADMIN": "Admin" },
    "overview": { "title": "Resumen", "welcome": "Bienvenido de nuevo, {name}.", "customerLead": "Crea un envío o revisa tu historial de envíos.", "staffLead": "Busca envíos y registra eventos de rastreo.", "totalShipments": "Tus envíos", "createCta": "Crear un envío", "viewAll": "Ver todos los envíos" }
  },
  "Shipments": {
    "mineTitle": "Mis envíos", "allTitle": "Todos los envíos", "empty": "Aún no hay envíos.", "newShipment": "Nuevo envío",
    "search": { "statusLabel": "Filtrar por estado", "all": "Todos los estados" },
    "table": { "code": "Guía", "status": "Estado", "route": "Ruta", "service": "Servicio", "created": "Creado", "price": "Precio" },
    "view": "Ver", "resultCount": "{count, plural, one {# envío} other {# envíos}}"
  },
  "Wallet": {
    "title": "Billetera", "balance": "Saldo", "amount": "Monto (USD)", "addFunds": "Agregar fondos", "invalidAmount": "Ingresa un monto válido.",
    "history": "Historial de transacciones", "empty": "Aún no hay transacciones.", "kinds": { "TOPUP": "Recarga", "PAYMENT": "Pago", "REVERSAL": "Reverso" }
  },
  "ShipmentDetail": {
    "back": "Volver a envíos", "downloadLabel": "Descargar etiqueta", "pay": "Pagar {amount}", "payInsufficient": "Saldo insuficiente — recarga tu billetera primero.", "paid": "Etiqueta pagada",
    "service": "Servicio", "estimated": "Entrega estimada", "noEstimate": "Por confirmar", "from": "Desde", "to": "Hasta", "price": "Precio", "weight": "Peso", "dimensions": "Dimensiones", "timeline": "Historial de rastreo",
    "registerEvent": { "title": "Registrar evento de rastreo", "status": "Nuevo estado", "location": "Ubicación", "locationPlaceholder": "ej. Miami, US", "description": "Descripción", "descriptionPlaceholder": "ej. Llegó a bodega destino", "submit": "Registrar evento", "noTransitions": "Este envío llegó a un estado final y no puede avanzar.", "errorInvalid": "Esa transición no está permitida." }
  },
  "Wizard": {
    "title": "Nuevo envío",
    "steps": { "addresses": "Direcciones", "parcel": "Paquete", "service": "Servicio", "review": "Revisar" },
    "origin": "Origen", "destination": "Destino",
    "fields": { "contactName": "Nombre de contacto", "line1": "Dirección línea 1", "city": "Ciudad", "state": "Estado / Provincia (opcional)", "postalCode": "Código postal", "country": "País", "weight": "Peso (kg)", "length": "Largo (cm)", "width": "Ancho (cm)", "height": "Alto (cm)", "serviceLevel": "Nivel de servicio" },
    "estimate": { "title": "Precio estimado", "eta": "Tránsito estimado", "etaDays": "{min}–{max} días hábiles" },
    "review": { "title": "Revisar y confirmar", "parcelSummary": "{weight} kg · {l}×{w}×{h} cm" },
    "back": "Atrás", "next": "Siguiente", "submit": "Crear envío", "created": "Envío {code} creado.", "error": "Completa todos los campos." }
  ,
  "Demo": {
    "banner": "Demo estática — todo corre en tu navegador, sin servidor. Los datos se guardan en localStorage.",
    "reset": "Reiniciar datos demo",
    "reseted": "Datos demo reiniciados."
  },
  "NotFound": { "title": "Página no encontrada", "body": "La página que buscas no existe.", "home": "Volver al inicio" }
};

const MESSAGES = { en, es };

function lookup(dict, key) {
  return key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

/** Format ICU-lite templates: {count, plural, …} then {placeholder}. */
function format(template, params = {}) {
  let out = template.replace(
    /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g,
    (_match, name, one, other) => {
      const n = Number(params[name] ?? 0);
      return (n === 1 ? one : other).replace(/#/g, String(n));
    },
  );
  out = out.replace(/\{(\w+)\}/g, (_match, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
  return out;
}

export const LOCALES = ["es", "en"];

/** Returns a translator bound to `locale`, falling back to English. */
export function createT(locale) {
  const dict = MESSAGES[locale] ?? MESSAGES.en;
  const t = (key, params) => {
    const raw = lookup(dict, key) ?? lookup(MESSAGES.en, key) ?? key;
    return typeof raw === "string" ? format(raw, params) : raw;
  };
  // Raw (unformatted) access, e.g. for the FAQ items array.
  t.raw = (key) => lookup(dict, key) ?? lookup(MESSAGES.en, key);
  t.locale = locale;
  return t;
}
