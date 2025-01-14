// server.js

require('dotenv').config(); // Load environment variables from .env
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
const MAX_TOKEN_LIMIT = 8200; // Tokens per minute limit (updated from 6000 to 8200)

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
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
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
  message: 'Too many requests from this IP, please try again after a minute.',
});

app.use(limiter);

// **Groq AI API Key from Environment Variables**
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error('Error: GROQ_API_KEY is not defined in the environment variables.');
  process.exit(1); // Exit the application if API key is missing
}

// Initialize Groq SDK with the API key
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Function to fetch rendered HTML using Puppeteer
async function fetchRenderedHTML(url) {
  try {
    console.log(`Launching Puppeteer to fetch: ${url}`);
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
    });

    const page = await browser.newPage();

    // Increase navigation timeout to 120 seconds
    page.setDefaultNavigationTimeout(120000);

    // Set a custom user agent (optional but can help bypass basic bot detection)
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Navigate using 'domcontentloaded' to ensure basic HTML is loaded
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const html = await page.content();
    await browser.close();
    console.log(`Successfully fetched HTML content from: ${url}`);
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
  console.log('Extracted text content from HTML.');
  return text;
}

// Function to generate the fixed prompt with the provided text content
function generatePrompt(textContent) {
  // Truncate the textContent to MAX_CHAR_LIMIT
  let truncatedText = textContent;
  if (textContent.length > MAX_CHAR_LIMIT) {
    truncatedText = textContent.substring(0, MAX_CHAR_LIMIT) + '... [Content Truncated]';
    console.log('Text content truncated to meet the maximum character limit.');
  }

  return `Please analyze the following text and perform the following tasks:

1. **Extract Information:**
   - **Phone Numbers:** Identify and list all phone numbers.
   - **Physical Addresses:** Identify and list all physical addresses.

2. **Summary:**
   - Provide a brief summary of the main points or content of the text.

**Response Format:**
Respond exclusively with a JSON object containing the following fields:
- \`phoneNumbers\`: An array of extracted phone numbers.
- \`addresses\`: An array of extracted physical addresses.
- \`summary\`: A string containing the brief summary.

**Example Response:**
\`\`\`json
{
  "phoneNumbers": ["+1-234-567-8900"],
  "addresses": ["123 Main St, Anytown, USA"],
  "summary": "This text discusses the upcoming company meeting and contact information."
}
\`\`\`

**Text to Analyze:**
\`\`\`
${truncatedText}
\`\`\`
`;
}

// Function to interact with Groq AI API with Exponential Backoff
async function getGroqChatCompletion(prompt, retries = 3, delay = 1000) {
  try {
    console.log('Sending prompt to Groq AI API.');
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
    console.log('Received response from Groq AI API.');
    return responseContent;
  } catch (error) {
    if (error.code === 'rate_limit_exceeded' && retries > 0) {
      console.warn(`Rate limit exceeded. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise((res) => setTimeout(res, delay));
      return getGroqChatCompletion(prompt, retries - 1, delay * 2);
    } else {
      console.error('Error communicating with Groq AI API:', error.message);
      throw new Error(error.message || 'Failed to communicate with Groq AI API.');
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

  console.log('Data extraction using regex completed.');
  return extracted;
}

// Endpoint to handle scraping
app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    console.error('No URL provided in the request body.');
    return res.status(400).json({ error: 'URL is required.' });
  }

  try {
    console.log(`Received scrape request for URL: ${url}`);

    // Step 1: Fetch the rendered webpage content using Puppeteer
    const htmlContent = await fetchRenderedHTML(url);

    // Step 2: Extract text content from the webpage
    const textContent = extractTextContent(htmlContent);

    // Step 3: Extract data using improved regex patterns
    const extractedData = extractData(textContent);

    // Log the extracted data for debugging
    console.log('Extracted Data (Regex):', extractedData);

    // Step 4: Generate a fixed prompt with the provided text content
    const prompt = generatePrompt(textContent);

    // Step 5: Send the prompt to Groq AI API with Exponential Backoff
    const aiResponse = await getGroqChatCompletion(prompt);

    if (!aiResponse) {
      console.error('Empty response received from Groq AI API.');
      // Return the Greek error message if the AI response is empty
      throw new Error('Αποτυχία ανάκτησης του περιεχομένου της ιστοσελίδας.');
    }

    // Step 6: Clean the AI response
    const cleanedResponse = cleanResponse(aiResponse);
    console.log('Cleaned AI response:', cleanedResponse);

    // Step 7: Parse the cleaned response as JSON
    let parsedResponse = {};
    try {
      parsedResponse = JSON.parse(cleanedResponse);
      console.log('Parsed AI response:', parsedResponse);
    } catch (jsonError) {
      console.error('JSON Parsing Error:', jsonError.message);
      throw new Error('Αποτυχία ανάκτησης του περιεχομένου της ιστοσελίδας.');
    }

    // Validate the parsed response
    const { phoneNumbers, addresses, summary } = parsedResponse;

    if (
      !Array.isArray(phoneNumbers) ||
      !Array.isArray(addresses) ||
      typeof summary !== 'string'
    ) {
      console.error('Invalid response structure from Groq AI API.');
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

    console.log('Successfully processed scrape request and responded to the client.');
  } catch (error) {
    // Return Greek error message in the response if an error occurs
    console.error('Error processing the scraping request:', error.message);
    res.status(500).json({
      error: error.message || 'Αποτυχία ανάκτησης του περιεχομένου της ιστοσελίδας.',
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
