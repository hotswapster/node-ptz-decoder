/*
 *
 * Read and decode Pelco D and Pelco P CCTV commands
 * Used to monitor the output from Pelco systems or the inputs into Pelco cameras
 * Copyright 2016 Roger Hardiman
 *
 *
 * Read the Buffer() objects from the a stream and process Pelco D messages
 * Buffer() objects may have multiple Pelco messages or just part of a message
 * so bytes are cached if needed
 *
 */
/*
 *  SOURCE MATERIAL
 *  Pelco D data sheet (official Pelco document - 1999 Edition)
 *  Official Pelco KBD300A in Direct D and Direct P modes
 *
 *  NuOptic D Protocol http://www.nuoptic.com/wp-content/uploads/files/NuOptic_VIS-1000_D-Protocol_Reference.pdf
 *  CodeProject Pelco D and Pelco P pages http://www.codeproject.com/Articles/8034/Pelco-P-and-D-protocol-implementation-in-C
 *  ZoneMinder Source Code https://github.com/ZoneMinder/ZoneMinder/tree/master/scripts/ZoneMinder/lib/ZoneMinder/Control 
 *  iSpyConnect Source Code https://github.com/ispysoftware/iSpy/tree/master/Pelco
 *  Node-Pelco Source Code https://github.com/Scoup/node-pelcod
 *  CommFront 232 Analizer https://www.commfront.com/pages/pelco-d-protocol-tutorial
 *  CommFront 232 Analizer https://www.commfront.com/pages/pelco-p-protocol-tutorial
 * 
 *  Pelco D Commands are 7 bytes long, start with 0xFF and have a 'sum' checksum
 *  Checksum is Sum of bytes 2 to 6 Modulo 256
 *  Camera 1 has Address 01
 *  +-----------+---------+-----------+-----------+--------+--------+-----------+
 *  |   BYTE 1  | BYTE 2  |  BYTE 3   |  BYTE 4   | BYTE 5 | BYTE 6 |  BYTE 7   |
 *  +-----------+---------+-----------+-----------+--------+--------+-----------+
 *  |           |         |           |           |        |        |           |
 *  | Sync(0xFF)| Address | Command 1 | Command 2 | Data 1 | Data 2 | Check Sum |
 *  +-----------+---------+-----------+-----------+--------+--------+-----------+
 *
 *  Pelco P Commands are 8 bytes long, include STX and ETX and have a 'XOR' checksum
 *  Checksum is XOR of bytes 1 to 7
 *  Camera 1 has Address 00
 *  +-----------+---------+-----------+-----------+--------+--------+-----------+-----------+
 *  |   BYTE 1  | BYTE 2  |  BYTE 3   |  BYTE 4   | BYTE 5 | BYTE 6 |   BYTE 7  |  BYTE 8   |
 *  +-----------+---------+-----------+-----------+--------+--------+-----------+-----------+
 *  |           |         |           |           |        |        |           |           |
 *  | STX(0xA0) | Address | Command 1 | Command 2 | Data 1 | Data 2 | ETX(0xAF) | Check Sum |
 *  +-----------+---------+-----------+-----------+--------+--------+-----------+-----------+
 *
 *  There are two types of command - Standard and Extended
 *
 *
 * STANDARD COMMANDS
 * Pelco D Format
 * Used to control Pan,Tilt,Zoom,Focus and Iris. Bytes 5 and 6 contain Pan and Tilt speeds
 *  +---------+---------+--------+---------+------------------+---------------+----------+---------+----------+
 *  |         |  BIT 7  | BIT 6  |  BIT 5  |      BIT 4       |     BIT 3     |  BIT 2   |  BIT 1  |  BIT 0   |
 *  +---------+---------+--------+---------+------------------+---------------+----------+---------+----------+
 *  |         |         |        |         |                  |               |          |         |          |
 *  |Command 1|Sense    |Reserved|Reserved |Auto / Manual Scan|Camera On / Off|Iris Close|Iris Open|Focus Near|
 *  |         |         |        |         |                  |               |          |         |          |
 *  |Command 2|Focus Far|Zoom    |Zoom Tele|Down              |Up             |Left      |Right    |Always 0  |
 *  +---------+---------+--------+---------+------------------+---------------+----------+---------+----------+
 *
 * Pelco P Format
 * Used to control Pan,Tilt,Zoom,Focus and Iris. Bytes 5 and 6 contain Pan and Tilt speeds
 *  +---------+--------+-------------+---------------+-------------+----------+---------+---------+----------+
 *  |         |  BIT 7 |    BIT 6    |     BIT 5     |   BIT 4     |  BIT 3   |  BIT 2  |  BIT 1  |  BIT 0   |
 *  +---------+--------+-------------+---------------+-------------+----------+---------+---------+----------+
 *  |         |        |             |               |             |          |         |         |          |
 *  |Command 1|Unknown |Unknown      |Unknown        |Unknown      |Iris Close|Iris Open|Focus Near|Focus Far|
 *  |         |        |             |               |             |          |         |         |          |
 *  |Command 2|Unknown |Zoom Wide    |Zoom Tele      |Tilt Down    |Tilt Up   |Pan Left |Pan Right|Always 0  |
 *  +---------+--------+-------------+---------------+-------------+----------+---------+---------+----------+
 * The Pelco P table comes from various web sites and not from any formal documents and so the true meanings of
 * Command 1 bits 7,6,5 and 4 and Command 2 bit 7 is not properly known. One site lists some of these as
 * Camera On/Off and Auto Scan bits but cannot verify this.
 *
 *
 * EXTENDED COMMANDS
 * Bit 0 of Command 2 is set to '1' for extended commands.
 * Bytes 3,4,5 and 6 contain the extended command and any values
 * There are a large number of extended commands. This code processes the common commands.
 *  +--------------------------------+--------+--------+--------+-------------+----+
 *  |                                | BYTE 3 | BYTE 4 | BYTE 5 | BYTE 6      |D/P |
 *  |                                | Cmd 1  | Cmd 2  | Data 1 | Data 2      |    |
 *  +--------------------------------+--------+--------+--------+-------------+----+
 *  |                                |        |        |        |             |    |
 *  | Set Preset                     | 00     | 03     | 00     | value       |Both|
 *  |                                |        |        |        |             |    |
 *  | Clear Preset                   | 00     | 05     | 00     | value       |Both|
 *  |                                |        |        |        |             |    |
 *  | Go To Preset                   | 00     | 07     | 00     | value       |Both|
 *  |   Flip (180deg about)          | 00     | 07     | 00     | 21          |    |
 *  |   Go To Zero Pan               | 00     | 07     | 00     | 22          |    |
 *  |                                |        |        |        |             |    |
 *  | Set Auxiliary                  | 00     | 09     | 00     | value       |Both|
 *  |                                |        |        |        |             |    |
 *  | Clear Auxiliary                | 00     | 0B     | 00     | value       |Both|
 *  |                                |        |        |        |             |    |
 *  | Set Pattern Start              | 00     | 1F     | 00     | value       |Both|
 *  |                                |        |        |        |             |    |
 *  | Set Pattern Stop               | 00     | 21     | 00     | value       |Both|
 *  |                                |        |        |        |             |    |
 *  | Run Pattern                    | 00     | 23     | 00     | value       |Both|
 *  |                                |        |        |        |             |    |
 *  | Set Zoom Speed                 | 00     | 25     | 00     | value (0-3) |Both|
 *  |                                |        |        |        |             |    |
 *  +--------------------------------+--------+--------+--------+-------------+----+
 *
 */

function PelcoD_Decoder() {

    // A Buffer used to cache partial commands
    this.pelco_command_buffer = new Buffer(7);

    // Number of bytes in the current Buffer
    this.pelco_command_index = 0;

    // A Buffer used to cache partial commands for Pelco P
    this.pelco_p_command_buffer = new Buffer(8);

    // Number of bytes in the current Buffer
    this.pelco_p_command_index = 0;

    // A Buffer used for byte Bosch/Philips BiPhase
    // Max length is 128 as length is bits 0 to 6 of header
    this.bosch_command_buffer = new Buffer(128);

    // Number of bytes in the current Buffer
    this.bosch_command_index = 0;

}


PelcoD_Decoder.prototype.processBuffer = function(new_data_buffer) {

    // console.log('received ' + this.bytes_to_string(new_data_buffer,new_data_buffer.length) );

    // process each byte from new_data_buffer in turn

    for (var i = 0; i < new_data_buffer.length; i++) {

        // Get the next new byte
        var new_byte = new_data_buffer[i];

        // Add to Pelco D buffer
        if (this.pelco_command_index < this.pelco_command_buffer.length) {
            // Add the new_byte to the end of the pelco_command_buffer
            this.pelco_command_buffer[this.pelco_command_index] = new_byte;
            this.pelco_command_index++;
        } else {
            // Shift the bytes to make room for the new_byte at the end
            for (var x = 0; x < (this.pelco_command_buffer.length - 1); x++) {
                this.pelco_command_buffer[x] = this.pelco_command_buffer[x + 1];
            }
            // Then add the new_byte to the end
            this.pelco_command_buffer[this.pelco_command_buffer.length-1] = new_byte;
        }

        // Add to Pelco P buffer
        if (this.pelco_p_command_index < this.pelco_p_command_buffer.length) {
            // Add the new_byte to the end of the pelco_p_command_buffer
            this.pelco_p_command_buffer[this.pelco_p_command_index] = new_byte;
            this.pelco_p_command_index++;
        } else {
            // Shift the bytes to make room for the new_byte at the end
            for (var x = 0; x < (this.pelco_p_command_buffer.length - 1); x++) {
                this.pelco_p_command_buffer[x] = this.pelco_p_command_buffer[x + 1];
            }
            // Then add the new_byte to the end
            this.pelco_p_command_buffer[this.pelco_p_command_buffer.length-1] = new_byte;
        }

        // Add to Bosch 8 byte buffer
	if (new_byte & 0x80) {
console.log('BOSCH HEADER');
	    // MSB set to 1. This marks the start of a Bosch command so reset buffer counter
	    this.bosch_command_index = 0;
	}
        if (this.bosch_command_index < this.bosch_command_buffer.length) {
            // Add the new_byte to the end of the bosch_command_buffer
            this.bosch_command_buffer[this.bosch_command_index] = new_byte;
            this.bosch_command_index++;
        }


        // Pelco D Test. Check if we have 7 bytes with byte 0 = 0xFF and with a valid SUM checksum
        if (this.pelco_command_index === 7 && this.pelco_command_buffer[0] === 0xFF
                                           && this.checksum_valid(this.pelco_command_buffer)) {
            // Looks like we have a Pelco command. Try and process it
            this.decode(this.pelco_command_buffer);
            this.pelco_command_index = 0; // empty the buffer
        }

        // Pelco P Test. Check if we have 8 bytes with byte 0 = 0xA0, byte 6 = 0xAF and with a valid XOR checksum
        if (this.pelco_p_command_index === 8 && this.pelco_p_command_buffer[0] === 0xA0
                                             && this.pelco_p_command_buffer[6] === 0xAF
                                             && this.checksum_p_valid(this.pelco_p_command_buffer)) {
            // Looks like we have a Pelco command. Try and process it
            this.decode(this.pelco_p_command_buffer);
            this.pelco_p_command_index = 0; // empty the buffer
        }

        // Bosch Test. First byte has MSB of 1. First byte is the message size (excluding the checksum)
        var bosch_len = this.bosch_command_buffer[0] & 0x7F;
        if ((this.bosch_command_buffer[0] & 0x80)
                                             && this.bosch_command_index == (bosch_len + 1)
                                             && this.checksum_bosch_valid(this.bosch_command_buffer, this.bosch_command_index)) {
            // Looks like we have a Bosch command. Try and process it
            this.decode_bosch(this.bosch_command_buffer);
            this.bosch_command_index = 0; // empty the buffer
        }
    }
};

PelcoD_Decoder.prototype.checksum_valid = function(buffer) {
    var total = 0;
    // The 0xFF start byte is not included in the checksum
    for (var x = 1; x < (buffer.length - 1); x++) {
        total += buffer[x];
    }
    var computed_checksum = total % 256;
    // Check if computed_checksum matches the last byte in the buffer
    if (computed_checksum === buffer[buffer.length - 1]) {
        return true;
    } else {
        return false;
    }
};

PelcoD_Decoder.prototype.checksum_p_valid = function(buffer) {
    var computed_checksum = 0x00;
    for (var x = 0; x < (buffer.length - 1); x++) {
        computed_checksum = computed_checksum ^ buffer[x]; // xor
    }
    // Check if computed_checksum matches the last byte in the buffer
    if (computed_checksum === buffer[buffer.length - 1]) {
        return true;
    } else {
        return false;
    }
};

PelcoD_Decoder.prototype.checksum_bosch_valid = function(buffer,message_length) {
    var total = 0;
    for (var x = 0; x < (message_length - 1); x++) {
        total += buffer[x];
    }
    var computed_checksum = total & 0x7F; // MSB set to 1 is reserved for first byte.
    // Check if computed_checksum matches the last byte in the buffer
    if (computed_checksum === buffer[message_length - 1]) {
        return true;
    } else {
        return false;
    }
};

PelcoD_Decoder.prototype.decode = function(pelco_command_buffer) {

    var pelco_d = false;
    var pelco_p = false;
    var msg_string ='';

    if (pelco_command_buffer.length == 7) pelco_d = true;
    if (pelco_command_buffer.length == 8) pelco_p = true;

    if (pelco_d) {
        //var sync      = pelco_command_buffer[0];
        var camera_id = pelco_command_buffer[1];
        var command_1 = pelco_command_buffer[2];
        var command_2 = pelco_command_buffer[3];
        var data_1 = pelco_command_buffer[4];
        var data_2 = pelco_command_buffer[5];
        //var checksum  = pelco_command_buffer[6];

        var extended_command = ((command_2 & 0x01)==1);
        msg_string += 'D ';
    }
    if (pelco_p) {
        //var sync      = pelco_command_buffer[0];
        var camera_id = pelco_command_buffer[1] + 1; // Pelco P sends Cam1 as 0x00
        var command_1 = pelco_command_buffer[2];
        var command_2 = pelco_command_buffer[3];
        var data_1 = pelco_command_buffer[4];
        var data_2 = pelco_command_buffer[5];
        //var sync2  = pelco_command_buffer[6];
        //var checksum  = pelco_command_buffer[7];

        var extended_command = ((command_2 & 0x01)==1);
        msg_string += 'P ';
    }


	
    msg_string += 'Camera ' + camera_id + ' ';
    

    if (extended_command) {
        // Process extended commands
        // Command 1 (byte3) and Command 2 (byte 4) identifies the Extended Command
        // byte 5 and 6 contain additional data used by the extended commands

        if (command_2 === 0x03 && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[SET PRESET ' + data_2 + ']';
        } else if (command_2 === 0x05 && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[CLEAR PRESET ' + data_2 + ']';
        } else if (command_2 === 0x07 && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[GOTO PRESET ' + data_2 + ']';
        } else if (command_2 === 0x09 && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[SET AUX ' + data_2 + ']';
        } else if (command_2 === 0x0B && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[CLEAR AUX ' + data_2 + ']';
        } else if (command_2 === 0x1F && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[START RECORDING TOUR ' + data_2 + ']';
        } else if (command_2 === 0x21 && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[STOP RECORDING TOUR]';
        } else if (command_2 === 0x23 && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[START TOUR ' + data_2 + ']';
        } else if (command_2 === 0x25 && command_1 === 0x00 && data_1 === 0x00) {
            msg_string += '[SET ZOOM SPEED ' + data_2 + ']';
        } else {
            msg_string += 'Unknown extended command';
        }
    } else {
        // Process a normal Pan, Tilt, Zoom, Focus and Iris command

        if (pelco_d) {
            var iris_close = (command_1 >> 2) & 0x01;
            var iris_open = (command_1 >> 1) & 0x01;
            var focus_near = (command_1 >> 0) & 0x01;
            var focus_far = (command_2 >> 7) & 0x01;
            var zoom_out = (command_2 >> 6) & 0x01;
            var zoom_in = (command_2 >> 5) & 0x01;
            var down = (command_2 >> 4) & 0x01;
            var up = (command_2 >> 3) & 0x01;
            var left = (command_2 >> 2) & 0x01;
            var right = (command_2 >> 1) & 0x01;
        }
        if (pelco_p) {
            var iris_close = (command_1 >> 3) & 0x01;
            var iris_open = (command_1 >> 2) & 0x01;
            var focus_near = (command_1 >> 1) & 0x01;
            var focus_far = (command_1 >> 0) & 0x01;
            var zoom_out = (command_2 >> 6) & 0x01;
            var zoom_in = (command_2 >> 5) & 0x01;
            var down = (command_2 >> 4) & 0x01;
            var up = (command_2 >> 3) & 0x01;
            var left = (command_2 >> 2) & 0x01;
            var right = (command_2 >> 1) & 0x01;
        }

        if (left === 0 && right === 0) {
            msg_string += '[pan stop     ]';
        } else if (left === 1 && right === 0) {
            msg_string += '[PAN LEFT ('+data_1+')]';
        } else if (left === 0 && right === 1) {
            msg_string += '[PAN RIGHT('+data_1+')]';
        } else { // left === 1 && right === 1)
            msg_string += '[PAN ???? ('+data_1+')]';
        }

        if (up === 0 && down === 0) {
            msg_string += '[tilt stop    ]';
        } else if (up === 1 && down === 0) {
            msg_string += '[TILT UP  ('+data_2+')]';
        } else if (up === 0 && down === 1) {
            msg_string += '[TILT DOWN('+data_2+')]';
        } else { // (up === 1 && down === 1)
            msg_string += '[TILT ????('+data_2+')]';
        }

        if (zoom_in === 0 && zoom_out === 0) {
            msg_string += '[zoom stop]';
        } else if (zoom_in === 1 && zoom_out === 0) {
            msg_string += '[ZOOM IN  ]';
        } else if (zoom_in === 0 && zoom_out === 1) {
            msg_string += '[ZOOM OUT ]';
        } else { // (zoom_in === 1 && zoom_out === 1)
            msg_string += '[ZOOM ????]';
        }

        if (iris_open === 0 && iris_close === 0) {
            msg_string += '[iris stop ]';
        } else if (iris_open === 1 && iris_close === 0) {
            msg_string += '[IRIS OPEN ]';
        } else if (iris_open === 0 && iris_close === 1) {
            msg_string += '[IRIS CLOSE]';
        } else { // (iris_open === 1 && iris_close === 1)
            msg_string += '[IRIS ???? ]';
        }

        if (focus_near === 0 && focus_far === 0) {
            msg_string += '[focus stop]';
        } else if (focus_near === 1 && focus_far === 0) {
            msg_string += '[FOCUS NEAR]';
        } else if (focus_near === 0 && focus_far === 1) {
            msg_string += '[FOCUS FAR ]';
        } else { // (focus_near === 1 && focus_far === 1)
            msg_string += '[FOCUS ????]';
        }

    }
    console.log(this.bytes_to_string(pelco_command_buffer, pelco_command_buffer.length) + ' ' + msg_string);
};

PelcoD_Decoder.prototype.decode_bosch = function(bosch_command_buffer) {

    // Note Bosch is 9600 8-N-1

    var msg_string ='';

    msg_string += 'Bosch ';

    // TO DO - Add variable length message support
    var length      = bosch_command_buffer[0] & 0x7F;
    var high_order_address = bosch_command_buffer[1];
    var low_order_address = bosch_command_buffer[2];
    var op_code = bosch_command_buffer[3];
    //var data_byte_1 = bosch_command_buffer[4];
    //var data_byte_2 = bosch_command_buffer[5];
    //var data_byte_3 = bosch_command_buffer[6];
    //var data_byte_X = bosch_command_buffer[xxx];
    //var checksum = bosch_command_buffer[the last byte]

    var camera_id = (high_order_address << 7) + low_order_address + 1;

    msg_string += 'Camera ' + camera_id + ' ';
    
    // Process Op Code
    if (op_code == 0x02) {
        msg_string += 'Start/Stop Fixed Speed PTZ, Focus and Iris';
    }
    else if (op_code == 0x03) {
        msg_string += 'Fixed Speed PTZ for a specified period';
    }
    else if (op_code == 0x04) {
        msg_string += 'Repetitive Fixed Speed PTZ';
    }
    else if (op_code == 0x05) {
        msg_string += 'Start/Stop Variable Speed PTZ = ';
        // 3 data bytes used with this Op Code
        var data_1 = bosch_command_buffer[4];
        var data_2 = bosch_command_buffer[5];
        var data_3 = bosch_command_buffer[6];
        var zoom_speed = (data_1 >> 4) & 0x07;
        var tilt_speed = (data_1 >> 0) & 0x0F;
        var pan_speed  = (data_2 >> 3) & 0x0F;
        var iris_open  = (data_2 >> 2) & 0x01;
        var iris_close = (data_2 >> 1) & 0x01;
        var focus_far  = (data_2 >> 0) & 0x01;
        var focus_near = (data_3 >> 6) & 0x01;
        var zoom_in    = (data_3 >> 5) & 0x01;
        var zoom_out   = (data_3 >> 4) & 0x01;
        var up    = (data_3 >> 3) & 0x01;
        var down  = (data_3 >> 2) & 0x01;
        var left  = (data_3 >> 1) & 0x01;
        var right = (data_3 >> 0) & 0x01;


        if (left === 0 && right === 0) {
            msg_string += '[pan stop     ]';
        } else if (left === 1 && right === 0) {
            msg_string += '[PAN LEFT ('+pan_speed+')]';
        } else if (left === 0 && right === 1) {
            msg_string += '[PAN RIGHT('+pan_speed+')]';
        } else { // left === 1 && right === 1)
            msg_string += '[PAN ???? ('+pan_speed+')]';
        }

        if (up === 0 && down === 0) {
            msg_string += '[tilt stop    ]';
        } else if (up === 1 && down === 0) {
            msg_string += '[TILT UP  ('+tilt_speed+')]';
        } else if (up === 0 && down === 1) {
            msg_string += '[TILT DOWN('+tilt_speed+')]';
        } else { // (up === 1 && down === 1)
            msg_string += '[TILT ????('+tilt_speed+')]';
        }

        if (zoom_in === 0 && zoom_out === 0) {
            msg_string += '[zoom stop]';
        } else if (zoom_in === 1 && zoom_out === 0) {
            msg_string += '[ZOOM IN('+zoom_speed+')]';
        } else if (zoom_in === 0 && zoom_out === 1) {
            msg_string += '[ZOOM OUT('+zoom_speed+')]';
        } else { // (zoom_in === 1 && zoom_out === 1)
            msg_string += '[ZOOM ????]';
        }

        if (iris_open === 0 && iris_close === 0) {
            msg_string += '[iris stop ]';
        } else if (iris_open === 1 && iris_close === 0) {
            msg_string += '[IRIS OPEN ]';
        } else if (iris_open === 0 && iris_close === 1) {
            msg_string += '[IRIS CLOSE]';
        } else { // (iris_open === 1 && iris_close === 1)
            msg_string += '[IRIS ???? ]';
        }

        if (focus_near === 0 && focus_far === 0) {
            msg_string += '[focus stop]';
        } else if (focus_near === 1 && focus_far === 0) {
            msg_string += '[FOCUS NEAR]';
        } else if (focus_near === 0 && focus_far === 1) {
            msg_string += '[FOCUS FAR ]';
        } else { // (focus_near === 1 && focus_far === 1)
            msg_string += '[FOCUS ????]';
        }
    }
    else if (op_code == 0x06) {
        msg_string += 'Repetitive Fixed speed Zoom, Focus and Iris';
    }
    else if (op_code == 0x07) {
        msg_string += 'Auxiliary On/Off and Preposition Set/Shot = ';
        // 2 data bytes used with this Op Code
        var data_1 = bosch_command_buffer[4];
        var data_2 = bosch_command_buffer[5];
        var function_code = data_1 & 0x0F;
        var data = (data_1 >> 4) + data_2;
        if (function_code == 1) msg_string += 'Aux On ' + data;
        else if (function_code == 2) msg_string += 'Aux Off ' + data;
        else if (function_code == 4) msg_string += 'Pre-position SET ' + data;
        else if (function_code == 5) msg_string += 'Pre-position SHOT ' + data;
        else if (function_code == 8) msg_string += 'Cancel Latching Aux ' + data;
        else if (function_code == 9) msg_string += 'Latching Aux On ' + data;
        else if (function_code == 10) msg_string += 'Latching Aux Off ' + data;
	else msg_string += 'unknown aux or pre-position command ' + function_code + ' with value ' + data;
    }
    else if (op_code == 0x08) {
        msg_string += 'Repetitive Variable-speed PTZ, Focus and Iris';
    }
    else if (op_code == 0x09) {
        msg_string += 'Fine Speed PTZ';
    }
    else if (op_code == 0x0A) {
        msg_string += 'Position Report and Replay / Position Commands';
    }
    else if (op_code == 0x0C) {
        msg_string += 'Ping Command';
    }
    else if (op_code == 0x0F) {
        msg_string += 'Information Requested / Reply';
    }
    else if (op_code == 0x10) {
        msg_string += 'Title set';
    }
    else if (op_code == 0x12) {
        msg_string += 'Auxiliary Commands with Data';
    }
    else if (op_code == 0x13) {
        msg_string += 'Set Position / Get Position';
    }
    else if (op_code == 0x14) {
        msg_string += 'BiCom message';
    }
    else {
        msg_string += 'Unknown Op Code ' + op_code;
    }

    console.log(this.bytes_to_string(bosch_command_buffer,length+1) + ' ' + msg_string);
};

PelcoD_Decoder.prototype.bytes_to_string = function(buffer, length) {
    var byte_string = '';
    for (var i = 0; i < length; i++) {
        byte_string += '[' + this.DecToHexPad(buffer[i],2) + ']';
    }
    return byte_string;
};

PelcoD_Decoder.prototype.DecToHexPad = function(decimal,size) {
    var ret_string = decimal.toString('16');
    while (ret_string.length < size) {
        ret_string = '0' + ret_string;
    }
    return ret_string;
};

module.exports = PelcoD_Decoder;
