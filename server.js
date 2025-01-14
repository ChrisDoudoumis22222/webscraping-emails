// server.js

// Removed dotenv since we're hardcoding the API key
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Groq = require('groq-sdk'); // Import Groq SDK
const puppeteer = require('puppeteer'); // Import Puppeteer
const cheerio = require('cheerio'); // Import Cheerio
const morgan = require('morgan'); // Import Morgan for logging
const rateLimit = require('express-rate-limit'); // Import Rate Limiter
const winston = require('winston'); // Import Winston for advanced logging

const app = express();
// Use PORT from environment variables or default to 3000
const PORT = process.env.PORT || 3000;

// Configuration
const MAX_CHAR_LIMIT = 3000; // Maximum characters to send to AI
const MAX_TOKEN_LIMIT = 8200; // Tokens per minute limit

// Setup Logging with Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// If not in production, log to the console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

// Replace console.log and console.error with Winston
console.log = (...args) => logger.info(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));
app.use(morgan('combined')); // HTTP request logging

// Rate Limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 10, // limit each IP to 10 requests per windowMs
  message: 'Υπερβατήκατε το όριο αιτημάτων από αυτή την IP. Παρακαλώ δοκιμάστε ξανά μετά από ένα λεπτό.',
});

app.use(limiter);

// **Hardcoded Groq AI API Key**
const GROQ_API_KEY = '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';

// Verify that the API key is present
if (!GROQ_API_KEY) {
  console.error('Σφάλμα: Το GROQ_API_KEY δεν είναι ορισμένο.');
  process.exit(1); // Exit the application if API key is missing
}

// Initialize Groq SDK with the API key
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Function to fetch rendered HTML using Puppeteer
async function fetchRenderedHTML(url) {
  try {
    console.log(`Ξεκινώντας το Puppeteer για την ανάκτηση: ${url}`);
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
      // Optional: Specify executable path if necessary
      // executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    const page = await browser.newPage();

    // Set a custom user agent to mimic a real browser
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Increase navigation timeout to 120 seconds
    await page.setDefaultNavigationTimeout(120000);

    console.log('Μεταβαίνουμε στην ιστοσελίδα...');
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    console.log('Ανάκτηση περιεχομένου HTML...');
    const html = await page.content();

    await browser.close();
    console.log(`Επιτυχής ανάκτηση περιεχομένου από: ${url}`);
    return html;
  } catch (error) {
    console.error('Σφάλμα κατά την ανάκτηση του αποδιδόμενου HTML:', error.message);
    // Throw a Greek error message
    throw new Error('Αποτυχία ανάκτησης του περιεχομένου της ιστοσελίδας.');
  }
}

// Function to extract text content from HTML
function extractTextContent(htmlContent) {
  const $ = cheerio.load(htmlContent);
  const text = $('body').text();
  console.log('Εξαγωγή κειμένου από το HTML.');
  return text;
}

// Function to generate the fixed prompt with the provided text content
function generatePrompt(textContent) {
  // Truncate the textContent to MAX_CHAR_LIMIT
  let truncatedText = textContent;
  if (textContent.length > MAX_CHAR_LIMIT) {
    truncatedText = textContent.substring(0, MAX_CHAR_LIMIT) + '... [Περιεχόμενο Περιορίστηκε]';
    console.log('Το περιεχόμενο του κειμένου περιορίστηκε για να πληροί το μέγιστο όριο χαρακτήρων.');
  }

  return `Παρακαλώ αναλύστε το ακόλουθο κείμενο και εκτελέστε τις παρακάτω εργασίες:

1. **Εξαγωγή Πληροφοριών:**
   - **Διευθύνσεις Email:** Αναγνωρίστε και παραθέστε όλες τις διευθύνσεις email.
   - **Αριθμοί Τηλεφώνου:** Αναγνωρίστε και παραθέστε όλους τους αριθμούς τηλεφώνου.
   - **Φυσικές Διευθύνσεις:** Αναγνωρίστε και παραθέστε όλες τις φυσικές διευθύνσεις.

2. **Περίληψη:**
   - Παρέχετε μια σύντομη περίληψη των κύριων σημείων ή του περιεχομένου του κειμένου.

**Μορφή Απάντησης:**
Απαντήστε αποκλειστικά με ένα αντικείμενο JSON που περιέχει τα ακόλουθα πεδία:
- \`phoneNumbers\`: Ένα πίνακα με εξαγόμενους αριθμούς τηλεφώνου.
- \`addresses\`: Ένα πίνακα με εξαγόμενες φυσικές διευθύνσεις.
- \`summary\`: Ένα κείμενο που περιέχει τη σύντομη περίληψη.

**Παράδειγμα Απάντησης:**
\`\`\`json
{
  "phoneNumbers": ["+30-123-456-7890"],
  "addresses": ["Οδός Παπαδιαμάντη 15, Αθήνα, Ελλάδα"],
  "summary": "Το κείμενο συζητά την επερχόμενη εταιρική συνάντηση και τις πληροφορίες επικοινωνίας."
}
\`\`\`

**Κείμενο προς Ανάλυση:**
\`\`\`
${truncatedText}
\`\`\`
`;
}

// Function to interact with Groq AI API with Exponential Backoff
async function getGroqChatCompletion(prompt, retries = 3, delay = 1000) {
  try {
    console.log('Αποστολή προτροπής στο Groq AI API.');
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const responseContent = chatCompletion.choices[0]?.message?.content || '';
    console.log('Λήψη απάντησης από το Groq AI API.');
    return responseContent;
  } catch (error) {
    if (error.code === 'rate_limit_exceeded' && retries > 0) {
      console.warn(`Το όριο ρυθμού έχει υπερβεί. Προσπάθεια ξανά σε ${delay}ms... (${retries} επαναλήψεις απομένουν)`);
      await new Promise((res) => setTimeout(res, delay));
      return getGroqChatCompletion(prompt, retries - 1, delay * 2);
    } else {
      console.error('Σφάλμα στην επικοινωνία με το Groq AI API:', error.message);
      throw new Error(error.message || 'Αποτυχία επικοινωνίας με το Groq AI API.');
    }
  }
}

// Function to clean the AI response by removing code block markers and any non-JSON text
function cleanResponse(text) {
  // Remove any code block markers (e.g., ```json and ```)
  let cleanedText = text.replace(/```json|```/g, '').trim();

  // Remove any leading or trailing backticks or other unwanted characters
  cleanedText = cleanedText.replace(/^`+|`+$/g, '').trim();

  return cleanedText;
}

// Function to enhance data extraction with improved regex patterns
function extractData(textContent) {
  const dataPatterns = {
    emails: /[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, // Enhanced regex to capture standard emails
    phones: /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g,
    addresses: /\b\d{1,5}\s(?:[A-Za-z0-9#]+\s){1,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Square|Sq|Loop|Lp|Trail|Trl|Parkway|Pkwy)\b/gi,
  };

  const extracted = {
    emails: [],
    phones: [],
    addresses: [],
  };

  for (const [key, regex] of Object.entries(dataPatterns)) {
    const matches = textContent.match(regex);
    extracted[key] = matches ? matches : [];
  }

  console.log('Εξαγωγή δεδομένων χρησιμοποιώντας regex ολοκληρώθηκε.');
  return extracted;
}

// Endpoint to handle scraping
app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    console.error('Σφάλμα: Δεν παρέχεται URL στο σώμα του αιτήματος.');
    return res.status(400).json({ error: 'Το URL είναι απαραίτητο.' });
  }

  try {
    console.log(`Λήψη αιτήματος για scraping του URL: ${url}`);

    // Step 1: Fetch the rendered webpage content using Puppeteer
    const htmlContent = await fetchRenderedHTML(url);
    console.log('HTML περιεχόμενο ανακτήθηκε επιτυχώς.');

    // Step 2: Extract text content from the webpage
    const textContent = extractTextContent(htmlContent);
    console.log('Εξαγωγή κειμένου από το HTML ολοκληρώθηκε.');

    // Step 3: Extract data using improved regex patterns
    const extractedData = extractData(textContent);
    console.log('Δεδομένα εξαγωγής (Regex):', extractedData);

    // Step 4: Generate a fixed prompt with the provided text content
    const prompt = generatePrompt(textContent);

    // Step 5: Send the prompt to Groq AI API with Exponential Backoff
    const aiResponse = await getGroqChatCompletion(prompt);

    if (!aiResponse) {
      console.error('Λήψη κενής απάντησης από το Groq AI API.');
      throw new Error('Αποτυχία ανάκτησης του περιεχομένου της ιστοσελίδας.');
    }

    // Step 6: Clean the AI response
    const cleanedResponse = cleanResponse(aiResponse);
    console.log('Καθαρισμένη απάντηση από το AI:', cleanedResponse);

    // Step 7: Parse the cleaned response as JSON
    let parsedResponse = {};
    try {
      parsedResponse = JSON.parse(cleanedResponse);
      console.log('Αποδεσμευμένη απάντηση από το AI:', parsedResponse);
    } catch (jsonError) {
      console.error('Σφάλμα κατά την ανάλυση του JSON:', jsonError.message);
      throw new Error('Αποτυχία ανάκτησης του περιεχομένου της ιστοσελίδας.');
    }

    // Validate the parsed response
    const { phoneNumbers, addresses, summary } = parsedResponse;

    if (
      !Array.isArray(phoneNumbers) ||
      !Array.isArray(addresses) ||
      typeof summary !== 'string'
    ) {
      console.error('Μη έγκυρη δομή απάντησης από το Groq AI API.');
      throw new Error('Αποτυχία ανάκτησης του περιεχομένου της ιστοσελίδας.');
    }

    // Step 8: Respond to the frontend with extracted data and summary
    res.json({
      extractedData: {
        emails: extractedData.emails, // Use regex-extracted emails
        phoneNumbers,
        addresses,
      },
      summary,
    });

    console.log('Απάντηση αποσταλεί επιτυχώς στον πελάτη.');
  } catch (error) {
    console.error('Σφάλμα κατά την επεξεργασία του αιτήματος scraping:', error.message);
    res.status(500).json({ error: error.message || 'Αποτυχία επεξεργασίας του αιτήματος scraping.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Ο διακομιστής τρέχει στη θύρα ${PORT}`);
});
