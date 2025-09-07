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

client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Award points for any message (remove channel restriction)
    const userId = message.author.id;
    const username = message.author.username;
    const today = new Date().toISOString().split('T')[0];

    try {
        // Get member info from members table using discord_username first
        const { data: member, error: memberError } = await supabase
            .from('members')
            .select('id, bash_points')
            .eq('discord_username', username)
            .single();

        if (memberError || !member) {
            console.log(`Member with username ${username} not found in members table`);
            return;
        }

        // Check if user already got points today by looking at points table using member ID
        const { data: todayPoint, error: pointCheckError } = await supabase
            .from('points')
            .select('*')
            .eq('member_id', member.id)
            .eq('description', `DP'${today}`)
            .single();

        if (pointCheckError && pointCheckError.code !== 'PGRST116') {
            console.error('Error checking today points:', pointCheckError);
            return;
        }

        if (!todayPoint) {
            console.log(`Awarding 3 points to ${username}...`);
            
            const currentBashPoints = member.bash_points || 0;
            const newBashPoints = currentBashPoints + 3; // Award 3 points instead of 1

            console.log(`Current bash_points: ${currentBashPoints}, will update to: ${newBashPoints}`);

            // Update bash_points in members table with additional condition to prevent race conditions
            const { error: memberUpdateError, count } = await supabase
                .from('members')
                .update({ bash_points: newBashPoints })
                .eq('id', member.id)
                .eq('bash_points', currentBashPoints); // Only update if bash_points hasn't changed

            if (memberUpdateError) {
                console.error('Error updating member:', memberUpdateError);
                return;
            }

            if (count === 0) {
                console.log(`Race condition detected for ${username}, skipping update`);
                return;
            }

            // Add record to points table using member ID
            const { error: pointsError } = await supabase
                .from('points')
                .insert({
                    member_id: member.id,
                    organiser_id: 1,
                    points: 3, // Award 3 points instead of 1
                    updated_at: new Date().toISOString(),
                    description: `DP'${today}`
                });

            if (pointsError) {
                console.error('Error adding to points table:', pointsError);
            } else {
                console.log(`✅ Successfully awarded 3 points to ${username}. bash_points: ${currentBashPoints} → ${newBashPoints}`);
            }
        } else {
            console.log(`${username} already received points today`);
        }
    } catch (error) {
        console.error('Error processing message:', error);
    }
});

// 👇 Paste your token inside the quotes
client.login(process.env.DISCORD_TOKEN);

