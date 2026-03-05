import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DisableUserDto {
  @ApiProperty({ description: 'Set true to disable, false to re-enable' })
  @IsBoolean({ message: 'disabled must be a boolean' })
  disabled: boolean;
}
