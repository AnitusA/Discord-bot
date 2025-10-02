require('dotenv').config();

const { Client, GatewayIntentBits } = require("discord.js");
const { createClient } = require('@supabase/supabase-js');

// Supabase configuration
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Create bot client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Track processing messages to prevent race conditions
const processingMessages = new Set();

client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

/**
 * Process clan gathering points award
 * @param {Object} message - Discord message object
 * @param {Object} dateMatch - Regex match result for date
 * @returns {Promise<void>}
 */
async function processClanGathering(message, dateMatch) {
    const day = dateMatch[1];
    const month = dateMatch[2].charAt(0).toUpperCase() + dateMatch[2].slice(1).toLowerCase();
    const year = dateMatch[3] ? dateMatch[3].slice(-2) : new Date().getFullYear().toString().slice(-2);
    
    // Get the captain's info
    const { data: captain, error: captainError } = await supabase
        .from('members')
        .select('id, name, title, clan_id')
        .ilike('discord_username', message.author.username)
        .single();

    if (captainError || !captain) {
        await message.reply(`❌ You are not registered in the database.`);
        return;
    }

    // Check if user is a captain
    if (!captain.title || captain.title.toLowerCase() !== 'captain bash') {
        await message.reply(`❌ Only members with "Captain Bash" title can award clan gathering points.`);
        return;
    }

    if (!captain.clan_id) {
        await message.reply(`❌ You are not assigned to any clan.`);
        return;
    }

    const description = `CG-BC${captain.clan_id}-${day}${month}${year}`;
    
    // Prevent race condition - check if already processing this exact event
    if (processingMessages.has(description)) {
        console.log(`⏳ Already processing ${description}, skipping duplicate request`);
        return;
    }
    
    // Mark as processing
    processingMessages.add(description);
    
    try {
        // Check if points already awarded for this date (double-check in database)
        const { data: existingPoints, error: checkError } = await supabase
            .from('points')
            .select('id, updated_at')
            .eq('description', description)
            .limit(1);

        if (checkError) {
            await message.reply(`❌ Database error checking existing points: ${checkError.message}`);
            return;
        }

        if (existingPoints && existingPoints.length > 0) {
            // Get clan name for better error message
            const { data: clan } = await supabase
                .from('clans')
                .select('clan_name')
                .eq('id', captain.clan_id)
                .single();
            
            const clanName = clan?.clan_name || `Clan ${captain.clan_id}`;
            await message.reply(`❌ Points for **${day} ${month} ${dateMatch[3] || new Date().getFullYear()}** have already been awarded to **${clanName}**.`);
            return;
        }

        // Get all clan members
        const { data: clanMembers, error: membersError } = await supabase
            .from('members')
            .select('id, name, bash_points')
            .eq('clan_id', captain.clan_id);

        if (membersError) {
            await message.reply(`❌ Error fetching clan members: ${membersError.message}`);
            return;
        }

        if (!clanMembers || clanMembers.length === 0) {
            await message.reply(`❌ No clan members found.`);
            return;
        }

        // Get clan name
        const { data: clan, error: clanError } = await supabase
            .from('clans')
            .select('clan_name')
            .eq('id', captain.clan_id)
            .single();

        const clanName = clan?.clan_name || `Clan ${captain.clan_id}`;

        // First, create the points record to prevent any duplicates
        const { error: pointsError } = await supabase
            .from('points')
            .insert({
                member_id: captain.id,
                organiser_id: captain.id,
                points: 3,
                updated_at: new Date().toISOString(),
                description: description
            });

        if (pointsError) {
            // Check if it's a duplicate key error
            if (pointsError.code === '23505') {
                await message.reply(`❌ Points for **${day} ${month} ${dateMatch[3] || new Date().getFullYear()}** have already been awarded to **${clanName}**.`);
            } else {
                await message.reply(`❌ Error creating points record: ${pointsError.message}`);
            }
            return;
        }

        let successCount = 0;
        let failCount = 0;

        // Award points to each clan member
        for (const member of clanMembers) {
            try {
                const newBashPoints = (member.bash_points || 0) + 3;

                // Update bash_points
                const { error: updateError } = await supabase
                    .from('members')
                    .update({ bash_points: newBashPoints })
                    .eq('id', member.id);

                if (updateError) {
                    console.error(`Error updating points for member ${member.id}:`, updateError);
                    failCount++;
                } else {
                    successCount++;
                }
            } catch (err) {
                failCount++;
                console.error(`Error awarding points to member ${member.id}:`, err);
            }
        }

        await message.reply(`🎉 Your clan members awarded **3 points** for **${day} ${month} ${dateMatch[3] || new Date().getFullYear()}**'s clan gathering. Keep rocking **${clanName}**! 🚀\n\n✅ Awarded: ${successCount} members${failCount > 0 ? `\n❌ Failed: ${failCount} members` : ''}`);

    } catch (error) {
        console.error('Error in clan gathering:', error);
        await message.reply(`❌ Error processing clan gathering: ${error.message}`);
    } finally {
        // Remove from processing set after a delay to prevent rapid re-submissions
        setTimeout(() => {
            processingMessages.delete(description);
        }, 2000);
    }
}

client.on("messageCreate", async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Database check commands
    if (message.content.startsWith('!')) {
        const command = message.content.toLowerCase().split(' ')[0];

        // Check database connection
        if (command === '!checkdb') {
            try {
                const { count, error } = await supabase
                    .from('members')
                    .select('*', { count: 'exact', head: true });
                
                if (error) {
                    await message.reply(`❌ Database error: ${error.message}\n**Code:** ${error.code}\n**Details:** ${error.details || 'N/A'}\n**Hint:** ${error.hint || 'N/A'}`);
                } else {
                    await message.reply(`✅ Database connected! Total members: ${count || 0}`);
                }
            } catch (error) {
                await message.reply(`❌ Connection failed: ${error.message}\n**Stack:** ${error.stack?.substring(0, 200) || 'N/A'}`);
            }
            return;
        }

        // Check your points
        if (command === '!mypoints') {
            try {
                const { data: member, error } = await supabase
                    .from('members')
                    .select('id, name, discord_username, bash_points')
                    .ilike('discord_username', message.author.username)
                    .single();
                
                if (error || !member) {
                    await message.reply(`❌ Your Discord username (${message.author.username}) is not registered in the database.`);
                } else {
                    await message.reply(`📊 **${member.name || member.discord_username}** has **${member.bash_points || 0}** bash points!`);
                }
            } catch (error) {
                await message.reply(`❌ Error: ${error.message}`);
            }
            return;
        }

        // List all users
        if (command === '!listusers') {
            try {
                const { data: members, error } = await supabase
                    .from('members')
                    .select('name, discord_username, bash_points')
                    .order('bash_points', { ascending: false })
                    .limit(10);
                
                if (error) {
                    await message.reply(`❌ Error: ${error.message}`);
                } else if (members.length === 0) {
                    await message.reply(`📋 No members found in database.`);
                } else {
                    const userList = members
                        .map((m, i) => `${i + 1}. **${m.name || m.discord_username}**: ${m.bash_points || 0} points`)
                        .join('\n');
                    await message.reply(`📋 **Top Members:**\n${userList}`);
                }
            } catch (error) {
                await message.reply(`❌ Error: ${error.message}`);
            }
            return;
        }

        // Show help
        if (command === '!help') {
            await message.reply(`
**Available Commands:**
• \`!checkdb\` - Check database connection
• \`!mypoints\` - Check your bash points
• \`!listusers\` - Show top 10 members
• \`!cg\` or \`!clangathering\` - Award clan gathering points (Captain only)
• \`!debugschema\` - Debug schema and table info
• \`!help\` - Show this message

**Clan Gathering:**
Captains can award points by using \`!cg\` followed by a date, or just typing the date.
Example: \`!cg 13 Nov\` or just \`13 Nov 2025\`
            `);
            return;
        }

        // Debug schema
        if (command === '!debugschema') {
            try {
                // Try to query the members table with ALL columns
                const { data: membersData, error: membersError } = await supabase
                    .from('members')
                    .select('*')
                    .limit(1);

                let results = '**Schema Debug Results:**\n';
                results += `\n**Members table:**`;
                if (membersError) {
                    results += `\n❌ Error: ${membersError.message}\n   Code: ${membersError.code}\n   Details: ${membersError.details || 'N/A'}`;
                } else {
                    results += `\n✅ Found ${membersData?.length || 0} rows`;
                    if (membersData && membersData.length > 0) {
                        const columns = Object.keys(membersData[0]);
                        results += `\n   **Columns:** ${columns.join(', ')}`;
                        results += `\n   **Sample data:** ${JSON.stringify(membersData[0]).substring(0, 200)}`;
                    }
                }
                
                await message.reply(results);
            } catch (error) {
                await message.reply(`❌ Debug error: ${error.message}`);
            }
            return;
        }

        // Clan Gathering - Captain awards points to all clan members
        if (command === '!clangathering' || command === '!cg') {
            // Search for date in the entire message content (multiple formats)
            let dateMatch = message.content.match(/(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:\s*(\d{4}))?/i);
            
            if (!dateMatch) {
                // Format 2: ":date: 13 Nov 2025" or similar with emoji/prefix
                dateMatch = message.content.match(/:?date:?\s*(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:\s*(\d{4}))?/i);
            }

            if (!dateMatch) {
                await message.reply(`❌ **Requested Date Format:**\nPlease include a date in your message in one of these formats:\n• \`13 Nov\`\n• \`13 Nov 2025\`\n• \`:date: 13 Nov 2025\`\n• \`date: 13 Nov\``);
                return;
            }

            await processClanGathering(message, dateMatch);
            return;
        }
        
        // If any command was processed, return early to prevent automatic detection
        return;
    }

    // Check if message contains a date and user is Captain Bash (automatic detection)
    // This will only run for messages that DON'T start with !
    if (!message.content.startsWith('!')) {
        const datePattern = /(?:date:\s*)?(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:\s*(\d{4}))?/i;
        const dateMatch = message.content.match(datePattern);

        if (dateMatch) {
            try {
                console.log(`🔍 Date detected: ${dateMatch[0]} from user: ${message.author.username}`);
                
                // Get the captain's info to check if they're a Captain Bash
                const { data: captain, error: captainError } = await supabase
                    .from('members')
                    .select('id, name, title, clan_id')
                    .ilike('discord_username', message.author.username)
                    .single();

                console.log(`👤 User lookup result:`, captain ? `Found: ${captain.name}, Title: ${captain.title}` : 'Not found');

                // Only process if user is Captain Bash with a clan
                if (captain && captain.title && captain.title.toLowerCase() === 'captain bash' && captain.clan_id) {
                    console.log(`🎯 Captain confirmed, processing clan gathering for clan ${captain.clan_id}`);
                    await processClanGathering(message, dateMatch);
                }
            } catch (error) {
                console.error('Error in automatic clan gathering:', error);
            }
        }
    }

    // Removed: Daily progress points system
    // Only clan gathering points are now available
});

// 👇 Paste your token inside the quotes
client.login(process.env.DISCORD_TOKEN);

