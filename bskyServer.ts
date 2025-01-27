import { AtpAgent } from "@atproto/api";
import * as dotenv from "dotenv";
import { CronJob } from "cron";
import * as process from "process";
import Parser from "rss-parser";
import fs from "fs/promises";
import { decode } from "html-entities";
const cheerio = require("cheerio");
const axios = require("axios");
import sharp from "sharp";

dotenv.config();

interface BlobRefCustom {
  $type: "blob";
  ref: {
    $link: string;
  };
  mimeType: string;
  size: number;
}

interface CustomFeed {
  title: string;
  entry: CustomEntry[];
}

interface CustomEntry {
  title: { type: string; _text: string } | string;
  link: { href: string } | string;
  id: string;
}

// Initialize RSS parser with custom fields
const parser: Parser<CustomFeed, CustomEntry> = new Parser({
  customFields: {
    feed: ["entry"],
    item: [
      ["title", "title"],
      ["link", "link"],
      ["id", "id"],
    ],
  },
});

const agent = new AtpAgent({
  service: "https://bsky.social",
});

const CACHE_FILE = "posted_items.json";

interface PostedItems {
  guids: string[];
  lastFetchTime: number;
}

function getRandomInterval(): number {
  const minMinutes = 30;
  const maxMinutes = 120;
  return (
    Math.floor(Math.random() * (maxMinutes - minMinutes + 1) + minMinutes) *
    60 *
    1000
  );
  // return 0;
}

function truncateTitle(title: string, urlLength: number): string {
  // Calculate maximum title length (300 - URL length - 2 newlines - 2 dots)
  const maxLength = 300 - urlLength - 2 - 2;

  const decodedTitle = decode(title.replace(/<[^>]*>/g, "").trim());

  if (decodedTitle.length <= maxLength) {
    return decodedTitle;
  }

  return decodedTitle.substring(0, maxLength).trim() + ".."; // one . is added either by bsky or spinoff
}

async function loadPostedItems(): Promise<PostedItems> {
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {
      guids: [],
      lastFetchTime: 0,
    };
  }
}

async function downloadAndProcessImage(
  imageUrl: string,
): Promise<Buffer | null> {
  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });

    console.log("Image downloaded:", imageUrl);

    // max post size is 1mb, so image should be less than 1mb with room for other data
    const maxImageSize = 900000; // 900kb

    // loop until image is less than 900kb by reducing quality, with a minimum of 40 quality
    let processedImage = response.data;
    let quality = 100;
    while (processedImage.length > maxImageSize && quality > 40) {
      quality -= 5;
      processedImage = await sharp(response.data)
        .resize(1000, 1000, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .png({ quality })
        .toBuffer();

      console.log("Image processed with quality:", quality);
    }

    return processedImage;
  } catch (error) {
    console.error("Error processing image:", error);
    return null;
  }
}

async function uploadImageToBluesky(
  agent: AtpAgent,
  imageBuffer: Buffer,
): Promise<BlobRefCustom | null> {
  try {
    // Login first
    // check if logged in, if not, login
    let uploadResponse;

    try {
      uploadResponse = await agent.uploadBlob(imageBuffer, {
        encoding: "image/png",
      });
    } catch (error) {
      console.log(
        "Logging in in upload image flow, attempting login and retrying upload",
      );
      await agent.login({
        identifier: process.env.BLUESKY_USERNAME!,
        password: process.env.BLUESKY_PASSWORD!,
      });
      uploadResponse = await agent.uploadBlob(imageBuffer, {
        encoding: "image/png",
      });
    }

    return {
      $type: "blob",
      ref: {
        $link: uploadResponse.data.blob.ref.toString(),
      },
      mimeType: "image/png",
      size: imageBuffer.length,
    };
  } catch (error) {
    console.error("Error uploading to Bluesky:", error);
    return null;
  }
}

async function savePostedItems(items: PostedItems): Promise<void> {
  await fs.writeFile(CACHE_FILE, JSON.stringify(items));
  console.log("SAVED: " + items);
}

async function postToBluesky(
  title: string,
  url: string,
  thumb: BlobRefCustom,
  metaDescription: string,
) {
  try {
    console.log("Posting:", title);
    console.log("URL:", url);

    const processedTitle = truncateTitle(title, url.length);

    const postText = `${metaDescription}`;
    const postDescription = metaDescription.substring(0, 290).trim() + "...";

    // const cardTitle = `The Spinoff → ${processedTitle}`; // No longer used in this format

    console.log("Processed title:", processedTitle);

    // Create the embed object with optional thumb
    const embed = {
      $type: "app.bsky.embed.external",
      external: {
        uri: url,
        title: title,
        description: postDescription,
        ...(thumb && { thumb }),
      },
    };

    console.log("Embed:", embed);

    try {
      await agent.post({
        text: processedTitle,
        embed: embed,
      });
    } catch (error) {
      console.log(
        "Logging in in post flow, attempting login and retrying post",
      );
      await agent.login({
        identifier: process.env.BLUESKY_USERNAME!,
        password: process.env.BLUESKY_PASSWORD!,
      });
      await agent.post({
        text: postText,
        embed: embed,
      });
    }

    console.log("Posted successfully:", processedTitle);
  } catch (error) {
    console.error("Error posting to Bluesky:", error);
  }
}

async function processRSSFeed() {
  try {
    const postedItems = await loadPostedItems();
    const currentTime = Date.now();

    if (currentTime - postedItems.lastFetchTime < getRandomInterval()) {
      console.log("Skipping feed fetch - too soon since last check");
      return;
    }

    postedItems.lastFetchTime = currentTime;

    const feed = await parser.parseURL(process.env.RSS_FEED_URL!);

    console.log("Feed parsed successfully");
    console.log("Number of entries:", feed.items?.length || 0);

    if (!feed.items) {
      console.error("Feed items not found");
      return;
    }

    const latestItems = feed.items.slice(0, 8);

    // Process feed items - we want title and link
    for (const entry of latestItems) {
      const guid = entry.id;
      const title = entry.title;
      const url = entry.link;
      var metaDescription = title.slice(0, 290);

      // If already posted
      if (postedItems.guids.includes(guid)) {
        console.log("Skipping already posted item:", title);
        continue;
      }

      // Find and process image
      let thumb;
      try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        metaDescription =
          $('meta[property="og:description"]').attr("content") ||
          title.slice(0, 290);

        var imageUrl =
          $('meta[property="og:image"]').attr("content") ||
          $('meta[name="twitter:image"]').attr("content") ||
          $("article img").first().attr("src") ||
          $("main img").first().attr("src") ||
          $(".post-content img").first().attr("src");

        // if no image found, use default image
        if (!imageUrl) {
          imageUrl =
            "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:3hq7i54gjltbsl3pt5d37s3a/bafkreiczlei3r5fzmie2fwlsfgyzmotx4c4gho25rt6qoya76z3sfiudme@jpeg";
        }

        if (imageUrl) {
          // Handle relative URLs
          const fullImageUrl = imageUrl.startsWith("http")
            ? imageUrl
            : new URL(imageUrl, url).toString();

          console.log("Full image URL:", fullImageUrl);

          // Download and process the image
          const imageBuffer = await downloadAndProcessImage(fullImageUrl);

          if (imageBuffer) {
            // Upload to Bluesky and get blob reference
            console.log("imageBuffer:", imageBuffer);
            thumb = await uploadImageToBluesky(agent, imageBuffer);
            console.log("Thumb:", thumb);
          }
        }
      } catch (error) {
        console.error(`Error processing image for ${url}:`, error);
      }

      console.log("Processing item:", title);

      // Post to Bluesky with the thumb if available
      await postToBluesky(title, url, thumb!, metaDescription);
      postedItems.guids.push(guid);
      await savePostedItems(postedItems);

      // Random delay between posts (2-5 minutes)
      const delay = Math.floor(Math.random() * (5 - 2 + 1) + 2) * 60 * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    await savePostedItems(postedItems);
  } catch (error) {
    console.error("Error processing RSS feed:", error);

    if (error instanceof Error) {
      console.error("Error details:", error.message);
      console.error("Stack trace:", error.stack);
    }
  }
}

async function main() {
  // Initial delay
  // const initialDelay = Math.floor(Math.random() * (5 - 1 + 1) + 1) * 60 * 1000;
  // await new Promise(resolve => setTimeout(resolve, initialDelay));

  console.log("Starting bskyServer.js...");
  // Run first time
  await processRSSFeed();

  // Check every 15 mins
  const job = new CronJob("*/15 * * * *", processRSSFeed, null, true, "UTC");

  job.start();
}

main().catch(console.error);
