import { AtpAgent } from '@atproto/api';
import * as dotenv from 'dotenv';
import { CronJob } from 'cron';
import * as process from 'process';
import Parser from 'rss-parser';
import fs from 'fs/promises';
import { decode } from 'html-entities';
const cheerio = require('cheerio');
const axios = require('axios');
import sharp from 'sharp';

dotenv.config();

interface BlobRefCustom {
    $type: "blob";
    ref: {
        $link: string;
    };
    mimeType: string;
    size: number;
}

// Custom parser type to match the feed structure
interface CustomFeed {
    title: string;
    entry: CustomEntry[];  // Changed from entries to entry
}

interface CustomEntry {
    title: { type: string; _text: string; } | string;
    link: { href: string; } | string;
    id: string;
}

// Initialize RSS parser with custom fields
const parser: Parser<CustomFeed, CustomEntry> = new Parser({
    customFields: {
        feed: [
            'entry'  // Changed to match XML structure
        ],
        item: [
            ['title', 'title'],
            ['link', 'link'],
            ['id', 'id']
        ]
    }
});

const agent = new AtpAgent({
    service: 'https://bsky.social',
});

const CACHE_FILE = 'posted_items.json';

interface PostedItems {
    guids: string[];
    lastFetchTime: number;
}

function getRandomInterval(): number {
    const minMinutes = 30;
    const maxMinutes = 60;
    return Math.floor(Math.random() * (maxMinutes - minMinutes + 1) + minMinutes) * 60 * 1000;
    // return 0;
}

function truncateTitle(title: string, urlLength: number): string {
    // Calculate maximum title length (300 - URL length - 2 newlines - 3 dots)
    const maxLength = 300 - urlLength - 2 - 3;
    
    // Decode HTML entities and clean the title
    const decodedTitle = decode(title.replace(/<[^>]*>/g, '').trim());
    
    if (decodedTitle.length <= maxLength) {
        return decodedTitle;
    }
    
    // Truncate and add ellipsis
    return decodedTitle.substring(0, maxLength).trim() + '...';
}

async function loadPostedItems(): Promise<PostedItems> {
    try {
        const data = await fs.readFile(CACHE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { 
            guids: [],
            lastFetchTime: 0
        };
    }
}

async function downloadAndProcessImage(imageUrl: string): Promise<Buffer | null> {
    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer'
        });

        console.log('Image downloaded:', imageUrl);

        // Convert to PNG and resize if needed using sharp
        const processedImage = await sharp(response.data)
            .resize(1000, 1000, { 
                fit: 'inside',
                withoutEnlargement: true
            })
            .png()
            .toBuffer();

        return processedImage;
    } catch (error) {
        console.error('Error processing image:', error);
        return null;
    }
}

async function uploadImageToBluesky(agent: AtpAgent, imageBuffer: Buffer): Promise<BlobRefCustom | null> {
    try {
        // Login first
        // check if logged in, if not, login
        let uploadResponse;

        try {
            uploadResponse = await agent.uploadBlob(imageBuffer, {
                encoding: 'image/png'
            });
        }
        catch (error) {
            console.log('Logging in in upload image flow, attempting login and retrying upload');
            await agent.login({
                identifier: process.env.BLUESKY_USERNAME!,
                password: process.env.BLUESKY_PASSWORD!,
            });
            uploadResponse = await agent.uploadBlob(imageBuffer, {
                encoding: 'image/png'
            });
        }

        return {
            $type: "blob",
            ref: {
                $link: uploadResponse.data.blob.ref.toString()
            },
            mimeType: "image/png",
            size: imageBuffer.length
        };
    } catch (error) {
        console.error('Error uploading to Bluesky:', error);
        return null;
    }
}


async function savePostedItems(items: PostedItems): Promise<void> {
    await fs.writeFile(CACHE_FILE, JSON.stringify(items));
}

async function postToBluesky(title: string, url: string, thumb: BlobRefCustom) {
    try {

        console.log('Posting:', title);
        console.log('URL:', url);

        // Process the title
        const processedTitle = truncateTitle(title, url.length);
        
        // Create the post with title and URL on separate lines
        const postText = `${processedTitle}`;

        const cardTitle = `The Spinoff → ${processedTitle}`;

        console.log('Processed title:', processedTitle);
        
        // Create the embed object with optional thumb
        const embed = {
            $type: 'app.bsky.embed.external',
            external: {
                uri: url,
                title: cardTitle,
                description: '',
                ...(thumb && { thumb })
            },
        };

        console.log('Embed:', embed);

        try {
            await agent.post({
                text: postText,
                embed: embed,
            });
        }
        catch (error) {
            console.log('Logging in in post flow, attempting login and retrying post');
            await agent.login({
                identifier: process.env.BLUESKY_USERNAME!,
                password: process.env.BLUESKY_PASSWORD!,
            });
            await agent.post({
                text: postText,
                embed: embed,
            });
        }

        console.log('Posted successfully:', processedTitle);
    } catch (error) {
        console.error('Error posting to Bluesky:', error);
    }
}

async function processRSSFeed() {
    try {
        const postedItems = await loadPostedItems();
        const currentTime = Date.now();
        
        if (currentTime - postedItems.lastFetchTime < getRandomInterval()) {
            console.log('Skipping feed fetch - too soon since last check');
            return;
        }

        postedItems.lastFetchTime = currentTime;

        const feed = await parser.parseURL(process.env.RSS_FEED_URL!);
        
        // Debug logging
        console.log('Feed parsed successfully');
        console.log('Number of entries:', feed.items?.length || 0);

        // Check if feed exists
        if (!feed.items) {
            console.error('Feed items not found');
            return;
        }

        // Process feed items - we want title and link
        for (const entry of feed.items) {
            const guid = entry.id;
            const title = entry.title;
            const url = entry.link;

            // Check if the item was already posted
            if (postedItems.guids.includes(guid)) {
                console.log('Skipping already posted item:', title);
                continue;
            }

            // Find and process image
            let thumb;
            try {
                const response = await axios.get(url);
                const $ = cheerio.load(response.data);
                
                var imageUrl = $('meta[property="og:image"]').attr('content') ||
                        $('meta[name="twitter:image"]').attr('content') ||
                        $('article img').first().attr('src') ||
                        $('main img').first().attr('src') ||
                        $('.post-content img').first().attr('src');
                    
                // if no image found, use default image
                if (!imageUrl) {
                    imageUrl = 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:3hq7i54gjltbsl3pt5d37s3a/bafkreiczlei3r5fzmie2fwlsfgyzmotx4c4gho25rt6qoya76z3sfiudme@jpeg';
                }
                
                if (imageUrl) {
                    // Handle relative URLs
                    const fullImageUrl = imageUrl.startsWith('http') 
                        ? imageUrl 
                        : new URL(imageUrl, url).toString();

                    console.log('Full image URL:', fullImageUrl);
                    
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

            console.log('Processing item:', title);
            

            // Post to Bluesky with the thumb if available
            await postToBluesky(title, url, thumb!);
            postedItems.guids.push(guid);

            // Random delay between posts (2-5 minutes)
            const delay = Math.floor(Math.random() * (5 - 2 + 1) + 2) * 60 * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        await savePostedItems(postedItems);
    } catch (error) {
        console.error('Error processing RSS feed:', error);
        // Add more detailed error logging
        if (error instanceof Error) {
            console.error('Error details:', error.message);
            console.error('Stack trace:', error.stack);
        }
    }
}

async function main() {
    // Initial delay before first run (random 1-5 minutes)
    // const initialDelay = Math.floor(Math.random() * (5 - 1 + 1) + 1) * 60 * 1000;
    // await new Promise(resolve => setTimeout(resolve, initialDelay));
    
    // Run first time
    await processRSSFeed();
    
    // Schedule regular checks every 15 minutes
    const job = new CronJob(
        '*/2 * * * *',
        processRSSFeed,
        null,
        true,
        'UTC'
    );

    job.start();
}

main().catch(console.error);