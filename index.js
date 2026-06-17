const express = require('express');
const axiosBase = require('axios');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// ==========================================
// CANONICAL MARKET DATABASE
// ==========================================
const CANONICAL_MARKETS = [
    { id: '1', name: 'Roma' }, { id: '2', name: 'Kentucky Mid' }, { id: '3', name: 'Turin' },
    { id: '4', name: 'Florida Mid' }, { id: '5', name: 'Newyork Mid' }, { id: '6', name: 'Carolina Day' },
    { id: '7', name: 'Madrid' }, { id: '8', name: 'Bulgaria' }, { id: '9', name: 'Oregon 03' },
    { id: '10', name: 'Hungary' }, { id: '11', name: 'Miami' }, { id: '12', name: 'Oregon 06' },
    { id: '13', name: 'California' }, { id: '14', name: 'Florida Eve' }, { id: '15', name: 'Oregon 09' },
    { id: '16', name: 'Newyork Eve' }, { id: '17', name: 'Kentucky Eve' }, { id: '18', name: 'Austria' },
    { id: '19', name: 'Carolina Eve' }, { id: '20', name: 'Cambodia' }, { id: '21', name: 'Bullseye' },
    { id: '22', name: 'Laos' }, { id: '23', name: 'Oregon 12' }, { id: '24', name: 'Toto Macau P1' },
    { id: '25', name: 'Sydney' }, { id: '26', name: 'Guangdong' }, { id: '27', name: 'China' },
    { id: '28', name: 'Toto Macau 5D P1' }, { id: '29', name: 'Toto Macau P2' }, { id: '30', name: 'Philippines' },
    { id: '31', name: 'Japan' }, { id: '32', name: 'Singapore 4D' }, { id: '33', name: 'Jeju Lotto' },
    { id: '34', name: 'Toto Beijing' }, { id: '35', name: 'Toto Macau P3' }, { id: '36', name: 'Toto Fuzhou' },
    { id: '37', name: 'Cyprus' }, { id: '38', name: 'Taiwan' }, { id: '39', name: 'Toto Macau 5D P2' },
    { id: '40', name: 'Iceland' }, { id: '41', name: 'Toto Macau P4' }, { id: '42', name: 'Bhutan' },
    { id: '43', name: 'Hongkong' }, { id: '44', name: 'Toto Macau P5' }, { id: '45', name: 'Toronto' },
    { id: '46', name: 'Toto Macau P6' }, { id: '47', name: 'Singapore Toto' }, { id: '48', name: 'Kingkong P1' },
    { id: '49', name: 'Kingkong P2' }, { id: '50', name: 'Chengdu' }, { id: '51', name: 'Chongqing' },
    { id: '52', name: 'Cuba' }, { id: '53', name: 'Denver' }, { id: '54', name: 'Ecuador' },
    { id: '55', name: 'Foshan' }, { id: '56', name: 'Haiti' }, { id: '57', name: 'Kowloon' },
    { id: '58', name: 'Monaco' }, { id: '59', name: 'Taichung' }, { id: '60', name: 'Italy' },
    { id: '61', name: 'France' }, { id: '62', name: 'Chile' }, { id: '63', name: 'Mexico' },
    { id: '64', name: 'Oslo' }
];

const fixUrl = (raw) => {
    if (!raw) return null;
    let url = raw.trim().replace(/\/+$/, '');
    return url.startsWith('http') ? url : `https://${url}`;
};

const getDomainName = (url) => {
    if (!url || typeof url !== 'string') return 'Unknown Site';
    try {
        const cleanUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;
        const u = new URL(cleanUrl);
        return u.hostname.replace('www.', '') || 'Unknown Site';
    } catch {
        return url.trim() || 'Unknown Site';
    }
};

/**
 * FUNGSI EKSTRAKSI & VALIDASI FORMAT JUDUL
 */
function extractAndValidatePrediction(titleText, descText) {
    const regex = /PREDIKSI\s+TOGEL\s+(.+?)\s+(\d{1,2}\s+[A-Z]{3}\s+\d{4})/i;
    const match = titleText.match(regex);
    
    if (!match) return null;

    const rawMarket = match[1].trim();
    const rawDate = match[2].trim();

    // Cek Format Strip (-) untuk multi-word market
    const hasHyphen = rawMarket.includes('-');
    const isMultiWord = /\s/.test(rawMarket);
    
    let formatError = '';
    if (isMultiWord && !hasHyphen) {
        formatError = `Nama pasaran "${rawMarket}" seharusnya menggunakan tanda strip (-)`;
    }

    // Normalisasi untuk pencocokan lintas situs
    const normalizedMarket = rawMarket.toUpperCase().replace(/\s+/g, '-').replace(/--+/g, '-');
    const normalizedDate = rawDate.toLowerCase().replace(/\s+/g, '').replace(/juni/g, 'jun').replace(/juli/g, 'jul').substring(0, 7);

    // Cek Konsistensi Judul vs Deskripsi
    let consistencyError = '';
    const descLower = descText.toLowerCase();
    const marketKeywords = rawMarket.toLowerCase().split(/[\s\-]+/).filter(k => k.length > 2);
    const isMarketInDesc = marketKeywords.every(keyword => descLower.includes(keyword));
    
    if (!isMarketInDesc) {
        consistencyError = `Nama pasaran "${rawMarket}" tidak ditemukan dalam deskripsi.`;
    }

    const dateParts = rawDate.split(' ');
    const day = dateParts[0];
    const year = dateParts[2];
    const isDateInDesc = descLower.includes(`${day}`) && descLower.includes(`${year}`);

    if (!isDateInDesc) {
        consistencyError += ` Tanggal "${rawDate}" tidak konsisten dengan deskripsi.`;
    }

    return {
        rawTitle: titleText,
        marketName: rawMarket,
        normMarket: normalizedMarket,
        date: normalizedDate,
        formatError: formatError,
        consistencyError: consistencyError.trim()
    };
}

// ==========================================
// SCRAPING ENGINE KHUSUS PREDIKSI
// ==========================================
async function scrapePredictionPage(baseUrl, marketId) {
    try {
        const fixedBase = fixUrl(baseUrl);
        const jar = new CookieJar();
        const agent = new HttpsCookieAgent({ cookies: { jar } });
        
        const client = axiosBase.create({
            httpsAgent: agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml'
            },
            timeout: 15000
        });

        const res = await client.get(`${fixedBase}/prediksi?market=${marketId}`);
        const $ = cheerio.load(res.data);
        const predictions = [];

        $('div.flex.flex-col.items-center.gap-4.px-8.py-6').each((i, cardEl) => {
            const titleText = $(cardEl).find('h4 a').text().trim();
            const descText = $(cardEl).find('p.mt-1, p.text-sm').first().text().trim();

            if (titleText) {
                const extracted = extractAndValidatePrediction(titleText, descText);
                if (extracted) predictions.push(extracted);
            }
        });

        return { success: true, data: predictions };
    } catch (err) {
        return { 
            success: false, 
            error: err.response?.status === 419 ? 'CSRF Expired' : err.message 
        };
    }
}

// ==========================================
// VALIDASI KONTEN PREDIKSI
// ==========================================
function validatePredictionContent(marketName, siteResults, siteUrls) {
    const issues = [];
    const validSites = siteResults.filter(r => r.success && r.data.length > 0);
    const failedOrEmptySites = siteResults.filter(r => !r.success || r.data.length === 0);

    if (validSites.length === 0) return issues;

    const allDates = new Set();
    validSites.forEach(res => res.data.forEach(item => allDates.add(item.date)));

    for (const dateNorm of allDates) {
        const entries = siteResults.map((res, idx) => ({
            domain: getDomainName(siteUrls[idx]),
            success: res.success,
            hasData: res.success && res.data.length > 0,
            item: res.success ? res.data.find(d => d.date === dateNorm) : null
        }));

        const presentSites = entries.filter(e => e.item);
        const missingSites = entries.filter(e => !e.item && e.hasData);
        const failedSites = entries.filter(e => !e.success || !e.hasData);

        // CEK FORMAT ERROR
        presentSites.forEach(ps => {
            if (ps.item.formatError) {
                issues.push({
                    market: marketName, date: dateNorm, culprit: ps.domain,
                    status: 'FORMAT_ERROR', reference: `Judul: "${ps.item.rawTitle}"`,
                    detail: `FORMAT SALAH! ${ps.item.formatError}`
                });
            }
        });

        // CEK INCONSISTENCY
        presentSites.forEach(ps => {
            if (ps.item.consistencyError) {
                issues.push({
                    market: marketName, date: dateNorm, culprit: ps.domain,
                    status: 'CONTENT_INCONSISTENT', reference: `Judul: "${ps.item.rawTitle}"`,
                    detail: `TIDAK KONSISTEN! ${ps.item.consistencyError}`
                });
            }
        });

        // CEK MISSING DATA
        if (failedSites.length > 0 && presentSites.length === 0) {
            failedSites.forEach(fs => {
                issues.push({
                    market: marketName, date: dateNorm, culprit: fs.domain,
                    status: 'FETCH_FAILED', detail: 'Situs ini gagal memuat halaman prediksi.'
                });
            });
            continue; 
        }

        if (missingSites.length > 0 && presentSites.length >= (siteResults.length / 2)) {
            missingSites.forEach(ms => {
                issues.push({
                    market: marketName, date: dateNorm, culprit: ms.domain,
                    status: 'CONTENT_MISSING',
                    reference: `${presentSites.length}/${siteResults.length} situs lain memiliki prediksi untuk tanggal ini`,
                    detail: `Artikel prediksi untuk tanggal ${dateNorm} TIDAK DITEMUKAN.`
                });
            });
        }

        // CEK TITLE MISMATCH (Cross-validation antar situs)
        const consistentSites = presentSites.filter(ps => !ps.item.formatError && !ps.item.consistencyError);
        
        if (consistentSites.length >= 2) {
            const titleCounts = {};
            consistentSites.forEach(ps => {
                titleCounts[ps.item.rawTitle] = (titleCounts[ps.item.rawTitle] || 0) + 1;
            });

            const majorityTitle = Object.keys(titleCounts).reduce((a, b) => titleCounts[a] > titleCounts[b] ? a : b);

            consistentSites.forEach(ps => {
                if (ps.item.rawTitle !== majorityTitle) {
                    issues.push({
                        market: marketName, date: dateNorm, culprit: ps.domain,
                        status: 'TITLE_MISMATCH',
                        reference: `Judul Mayoritas: "${majorityTitle}"`,
                        detail: `JUDUL TIDAK STANDAR! Situs ini menulis: "${ps.item.rawTitle}"`
                    });
                }
            });
        }
    }

    failedOrEmptySites.forEach(fes => {
        if (validSites.length > 0) {
            issues.push({
                market: marketName, date: 'ALL_DATES', culprit: fes.domain,
                status: 'TOTAL_CONTENT_MISSING',
                detail: 'Halaman prediksi tidak mengembalikan artikel apapun.'
            });
        }
    });

    return issues;
}

// ==========================================
// ENDPOINT UTAMA: /scan-predictions
// ==========================================
app.get('/scan-predictions', async (req, res) => {
    try {
        const urls = Object.keys(req.query)
            .filter(key => key.startsWith('url'))
            .map(key => req.query[key])
            .filter(Boolean)
            .map(u => u.trim());
        
        if (urls.length < 2) {
            return res.status(400).json({ status: 'error', message: 'Minimal 2 URL diperlukan (?url1=...&url2=...)' });
        }

        const MAX_LIMIT = 25;
        if (urls.length > MAX_LIMIT) {
            return res.status(400).json({ 
                status: 'error', 
                message: `Maksimal ${MAX_LIMIT} situs. Anda memasukkan ${urls.length}.` 
            });
        }

        console.log(` Prediction Block Scan Started | ${urls.length} sites × 64 markets`);
        const startTime = Date.now();
        const allIssues = [];

        for (const market of CANONICAL_MARKETS) {
            console.log(`   Checking Predictions: ${market.name} (ID: ${market.id})...`);

            const siteResults = await Promise.all(
                urls.map(url => scrapePredictionPage(url, market.id))
            );

            const marketIssues = validatePredictionContent(market.name, siteResults, urls);
            allIssues.push(...marketIssues);
            
            await new Promise(r => setTimeout(r, 1200));
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        res.json({
            status: 'success',
            execution_time_seconds: duration,
            summary: {
                scanned_sites: urls.map(u => getDomainName(u)),
                markets_scanned: 64,
                total_issues_found: allIssues.length,
                is_fully_synced: allIssues.length === 0
            },
            errors: allIssues
        });
    } catch (err) {
        console.error('CRITICAL ERROR:', err);
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
});

// Health check endpoint untuk memastikan server hidup
app.get('/', (req, res) => res.json({ message: '🔮 Cek Blok Prediksi API Online!' }));

// ==========================================
// PRODUCTION SERVER SETUP (ANTI GAGAL KONEK)
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 Server running on port ${PORT}`);
    console.log(`🌐 Local: http://localhost:${PORT}`);
});

// Global Error Handler agar Railway tidak crash
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
